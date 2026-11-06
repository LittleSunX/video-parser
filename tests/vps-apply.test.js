import { afterEach, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  applyRelease,
  archiveLimits,
  parseReleaseArchive,
  replaceCurrent,
  validateArguments,
} from '../deploy/apply-vps-release.mjs'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const directories = []
const oldCommit = 'a'.repeat(40)
const commit = 'b'.repeat(40)
const oldId = '00000000-0000-4000-8000-000000000001'
const id = '00000000-0000-4000-8000-000000000002'
const site = 'https://video.example.com'
const builtAt = '2026-11-05T12:00:00.000Z'
const front = (sha = commit) => ({ commit: sha, builtAt })
const api = (sha = commit, uuid = id) => ({
  runtime: 'node',
  id: uuid,
  tag: sha,
  timestamp: builtAt,
})

afterEach(async () => {
  for (const { root, parent } of directories.splice(0)) {
    const path = await fs.realpath(root)
    if (dirname(path) !== parent || !basename(path).startsWith('video-parser-vps-apply-'))
      throw Error('Refusing to remove a directory outside the canonical test temp parent')
    await fs.rm(path, { recursive: true, force: true })
  }
})

function member(name, content = '', type = '0') {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.fill(32, 148, 156)
  header.write(type, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

function pack(members) {
  return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))
}

function contents({ frontend = front(), server = api(), extra = [] } = {}) {
  return [
    member('frontend/', '', '5'),
    member('frontend/assets/', '', '5'),
    member('frontend/index.html', '<!doctype html><html>current UI</html>'),
    member('frontend/assets/app.js', 'console.log("same-origin /api")'),
    member('frontend/version.json', JSON.stringify(frontend)),
    member('server/', '', '5'),
    member('server/index.mjs', 'console.log("server")'),
    member('server/version.json', JSON.stringify(server)),
    ...extra,
  ]
}

async function fixture(options = {}, temporaryParent = tmpdir()) {
  // Windows CI may expose TEMP as an 8.3 alias; all expected paths use real names.
  const parent = await fs.realpath(temporaryParent)
  const root = await fs.realpath(await fs.mkdtemp(join(parent, 'video-parser-vps-apply-')))
  directories.push({ root, parent })
  const previous = join(root, 'releases', oldId)
  await fs.mkdir(join(previous, 'frontend'), { recursive: true })
  await fs.mkdir(join(previous, 'server'))
  await fs.writeFile(join(previous, 'frontend/index.html'), 'previous UI')
  await fs.writeFile(join(previous, 'frontend/version.json'), JSON.stringify(front(oldCommit)))
  await fs.writeFile(join(previous, 'server/index.mjs'), 'previous server')
  await fs.writeFile(join(previous, 'server/version.json'), JSON.stringify(api(oldCommit, oldId)))
  await fs.symlink(
    previous,
    join(root, 'current'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const archive = join(root, 'upload.tar.gz')
  const bytes = pack(contents(options))
  await fs.writeFile(archive, bytes)
  const args = { archive, sha256: createHash('sha256').update(bytes).digest('hex'), site, commit }
  let running = api(oldCommit, oldId)
  const calls = [],
    requests = []
  const service = {
    ensureInstalled: vi.fn(async () => {
      calls.push('ensureInstalled')
    }),
    stop: vi.fn(async () => {
      calls.push('stop')
      running = undefined
    }),
    start: vi.fn(async () => {
      calls.push('start')
      const version = JSON.parse(
        await fs.readFile(join(root, 'current/server/version.json'), 'utf8'),
      )
      if (
        (version.id === id && options.failNewStart) ||
        (version.id === oldId && options.failOldStart)
      )
        throw Error('fake systemd refused start')
      running = version
    }),
  }
  const fetchFn = vi.fn(async (url, init) => {
    requests.push({ url: new URL(url), init })
    if (!running) return new Response('offline', { status: 503 })
    if (new URL(url).pathname === '/version.json')
      return Response.json(
        options.badPublicFrontend
          ? front(oldCommit)
          : JSON.parse(await fs.readFile(join(root, 'current/frontend/version.json'), 'utf8')),
      )
    let version = running
    if (new URL(url).origin === site && options.badPublicApi) version = { ...version, id: oldId }
    return Response.json({
      success: true,
      data: {
        service: 'video-parser-api',
        status: 'ok',
        runtime: version.runtime,
        version: version.id,
        versionTag: version.tag,
        versionCreatedAt: version.timestamp,
      },
    })
  })
  const switchCurrent = async (directory, target) => {
    // Windows directory junctions cannot replace a directory junction by rename.
    // Linux CI and production exercise the actual atomic rename implementation.
    if (process.platform === 'win32') await fs.unlink(join(directory, 'current'))
    await replaceCurrent(directory, target)
  }
  return {
    root,
    previous,
    args,
    calls,
    requests,
    service,
    deps: {
      root,
      service,
      fetchFn,
      switchCurrent,
      pollAttempts: 1,
      pollIntervalMs: 0,
      requestTimeoutMs: 100,
    },
  }
}

test('valid archives retain exact bytes and standard archive size bounds', () => {
  const entries = parseReleaseArchive(pack(contents()))
  expect(entries.get('server/version.json').body.toString()).toBe(JSON.stringify(api()))
  expect(entries.get('frontend/assets/app.js').directory).toBe(false)
  expect(archiveLimits).toEqual({
    compressed: 64 * 1024 * 1024,
    extracted: 128 * 1024 * 1024,
    entries: 10_000,
  })
})

test('deployment installs monitoring while stopped and requires a verified sample before success', async () => {
  const f = await fixture()
  const monitoring = {
    install: vi.fn(async () => {
      f.calls.push('monitor-install')
    }),
    verify: vi.fn(async () => {
      f.calls.push('monitor-verify')
    }),
    rollback: vi.fn(),
  }
  const prepareMonitoring = vi.fn(async () => monitoring)
  const result = await applyRelease(f.args, { ...f.deps, prepareMonitoring })
  expect(result.monitoring).toBe('verified')
  expect(f.calls).toEqual(['ensureInstalled', 'stop', 'monitor-install', 'start', 'monitor-verify'])
  expect(monitoring.verify).toHaveBeenCalledWith(id)
  expect(monitoring.rollback).not.toHaveBeenCalled()
})

test.each([false, true])(
  'failed first sample restores the API even if monitoring restore fails (%s)',
  async (restoreFails) => {
    const f = await fixture()
    const monitoring = {
      install: vi.fn(),
      verify: vi.fn(async () => {
        throw new Error('Wrong journal namespace')
      }),
      rollback: vi.fn(async () => {
        if (restoreFails) throw new Error('Restore failed')
      }),
    }
    await expect(
      applyRelease(f.args, { ...f.deps, prepareMonitoring: async () => monitoring }),
    ).rejects.toMatchObject({ status: restoreFails ? 'rollback_failed' : 'rolled_back' })
    expect(monitoring.rollback).toHaveBeenCalledOnce()
    expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
    expect(f.service.start).toHaveBeenCalledTimes(2)
  },
)

test('monitoring preflight failure never stops the running API', async () => {
  const f = await fixture()
  await expect(
    applyRelease(f.args, {
      ...f.deps,
      prepareMonitoring: async () => {
        throw new Error('Unsupported systemd')
      },
    }),
  ).rejects.toThrow('Unsupported systemd')
  expect(f.service.stop).not.toHaveBeenCalled()
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
})

test.each([
  ['/outside', '0'],
  ['frontend/../outside', '0'],
  ['frontend\\outside', '0'],
  ['frontend/./outside', '0'],
  ['frontend//outside', '0'],
  ['frontend/C:outside', '0'],
  ['server/.env', '0'],
  ['private.txt', '0'],
  ['frontend/link', '1'],
  ['frontend/link', '2'],
  ['frontend/device', '3'],
])('unsafe path or entry %s (%s) is rejected before extraction', (name, type) => {
  expect(() => parseReleaseArchive(pack([member(name, '', type)]))).toThrow()
})

test('tar checksum, end marker, duplicate files, parent conflicts and limits fail closed', () => {
  const corrupt = member('frontend/file', 'content')
  corrupt[0] ^= 1
  expect(() => parseReleaseArchive(pack([corrupt]))).toThrow('校验')
  expect(() => parseReleaseArchive(gzipSync(member('frontend/file', 'content')))).toThrow('结束')
  expect(() =>
    parseReleaseArchive(pack([member('frontend/file'), member('frontend/file')])),
  ).toThrow('重复')
  expect(() =>
    parseReleaseArchive(pack([member('frontend/file'), member('frontend/file/child')])),
  ).toThrow('冲突')
  const bytes = pack(contents())
  expect(() =>
    parseReleaseArchive(bytes, { ...archiveLimits, compressed: bytes.length - 1 }),
  ).toThrow('压缩包')
  expect(() => parseReleaseArchive(bytes, { ...archiveLimits, extracted: 512 })).toThrow('展开')
  expect(() => parseReleaseArchive(bytes, { ...archiveLimits, entries: 1 })).toThrow('条目')
})

test('PAX path attributes are revalidated and never turn into extraction links', () => {
  function pax(key, value) {
    const content = key + '=' + value + '\n'
    let length = Buffer.byteLength(content) + 2
    while (String(length).length + 1 + Buffer.byteLength(content) !== length)
      length = String(length).length + 1 + Buffer.byteLength(content)
    return member('PaxHeader', length + ' ' + content, 'x')
  }
  expect(() =>
    parseReleaseArchive(pack([pax('path', '../escape'), member('frontend/file')])),
  ).toThrow('路径')
  expect(() =>
    parseReleaseArchive(pack([pax('linkpath', '/etc/passwd'), member('frontend/file')])),
  ).toThrow('链接')
  expect(
    parseReleaseArchive(
      pack([pax('path', 'frontend/renamed'), member('frontend/file', 'same bytes')]),
    )
      .get('frontend/renamed')
      .body.toString(),
  ).toBe('same bytes')
})

test.each([
  'http://video.example.com',
  'https://video.example.com/sub/',
  'https://user:pass@video.example.com',
  'https://video.example.com/?token=x',
  'https://video.example.com/#fragment',
])('deployment site must be a clean HTTPS root: %s', (invalidSite) => {
  expect(() =>
    validateArguments({
      archive: 'release.tar.gz',
      sha256: 'a'.repeat(64),
      site: invalidSite,
      commit,
    }),
  ).toThrow('HTTPS')
})

test('success switches both artifacts, checks local and public IDs and keeps a rollback record', async () => {
  const f = await fixture()
  await fs.writeFile(join(f.root, 'current.next'), 'reserved operator file')
  const result = await applyRelease(f.args, f.deps)
  expect(result).toMatchObject({
    passed: true,
    status: 'succeeded',
    commit,
    releaseId: id,
    previousRelease: f.previous,
    previousCommit: oldCommit,
  })
  expect(await fs.realpath(join(f.root, 'current'))).toBe(await fs.realpath(result.release))
  expect(await fs.readFile(join(f.previous, 'frontend/index.html'), 'utf8')).toBe('previous UI')
  expect(await fs.readFile(join(f.root, 'current.next'), 'utf8')).toBe('reserved operator file')
  expect(f.calls).toEqual(['ensureInstalled', 'stop', 'start'])
  expect(f.requests.map(({ url }) => url.origin + url.pathname)).toEqual([
    'http://127.0.0.1:8787/api/health',
    'http://127.0.0.1:8787/api/health',
    site + '/version.json',
    site + '/api/health',
  ])
  for (const { url, init } of f.requests) {
    expect(url.searchParams.get('check')).toMatch(/^[a-f\d-]{36}$/)
    expect(init.headers['Cache-Control']).toBe('no-cache')
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' })
  }
  const record = JSON.parse(await fs.readFile(join(f.root, 'last-deployment.json'), 'utf8'))
  expect(record).toMatchObject({ status: 'succeeded', previousRelease: f.previous })
  expect(
    JSON.parse(
      await fs.readFile(join(f.root, 'deployments', result.transaction + '.json'), 'utf8'),
    ),
  ).toEqual(record)
  await expect(fs.lstat(join(f.root, '.deploy.lock'))).rejects.toHaveProperty('code', 'ENOENT')
  expect((await fs.readdir(f.root)).filter((name) => name.startsWith('.current-'))).toEqual([])
})

test('fixture paths stay canonical when the temp parent is reached through an alias', async () => {
  const owner = await fixture()
  const parent = await fs.realpath(tmpdir())
  const alias = join(owner.root, 'temporary-alias')
  await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const f = await fixture({}, alias)
  expect(dirname(f.root)).toBe(parent)
  expect(f.root).toBe(await fs.realpath(f.root))
  expect(f.previous).toBe(await fs.realpath(join(f.root, 'current')))
  await expect(applyRelease(f.args, f.deps)).resolves.toHaveProperty('status', 'succeeded')
})

test('a checksum mismatch leaves the active release and service untouched', async () => {
  const f = await fixture()
  await expect(applyRelease({ ...f.args, sha256: '0'.repeat(64) }, f.deps)).rejects.toHaveProperty(
    'code',
    'CHECKSUM_MISMATCH',
  )
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
  expect(f.calls).toEqual(['ensureInstalled'])
})

test.each([
  { frontend: front(oldCommit) },
  { server: { ...api(), runtime: 'cloudflare-worker' } },
  { server: { ...api(), id: '../outside' } },
  { server: { ...api(), timestamp: 'invalid' } },
])(
  'invalid or mismatched artifact versions fail before stopping the old process: %j',
  async (options) => {
    const f = await fixture(options)
    await expect(applyRelease(f.args, f.deps)).rejects.toThrow('版本')
    expect(f.calls).toEqual(['ensureInstalled'])
    expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
  },
)

test('missing installation, escaped current and absent systemd service require initial setup', async () => {
  const f = await fixture()
  f.service.ensureInstalled.mockRejectedValueOnce(Error('not installed'))
  await expect(applyRelease(f.args, f.deps)).rejects.toThrow('一次性安装')
  await fs.unlink(join(f.root, 'current'))
  await fs.symlink(
    f.root,
    join(f.root, 'current'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await expect(applyRelease(f.args, f.deps)).rejects.toHaveProperty('code', 'NOT_INSTALLED')
  await fs.unlink(join(f.root, 'current'))
  await fs.mkdir(join(f.root, 'current'))
  await expect(applyRelease(f.args, f.deps)).rejects.toHaveProperty('code', 'NOT_INSTALLED')
  expect(f.service.stop).not.toHaveBeenCalled()
})

test('an existing release is never overwritten', async () => {
  const f = await fixture()
  const target = join(f.root, 'releases', id)
  await fs.mkdir(target)
  await fs.writeFile(join(target, 'marker'), 'keep')
  await expect(applyRelease(f.args, f.deps)).rejects.toHaveProperty('code', 'RELEASE_EXISTS')
  expect(await fs.readFile(join(target, 'marker'), 'utf8')).toBe('keep')
  expect(f.service.stop).not.toHaveBeenCalled()
})

test('a partial write leaves the old pair online and the same archive can be retried', async () => {
  const f = await fixture()
  const releases = join(f.root, 'releases')
  const write = fs.writeFile.getMockImplementation()
  fs.writeFile
    .mockImplementationOnce(write)
    .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
  await expect(applyRelease(f.args, f.deps)).rejects.toHaveProperty('code', 'ENOSPC')
  expect(f.service.stop).not.toHaveBeenCalled()
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
  expect(await fs.readdir(releases)).toEqual([oldId])
  await expect(applyRelease(f.args, f.deps)).resolves.toMatchObject({ passed: true, releaseId: id })
})

test.each([{ failNewStart: true }, { badPublicFrontend: true }, { badPublicApi: true }])(
  'startup or public version failure restores the previous pair and verifies old health: %j',
  async (options) => {
    const f = await fixture(options)
    await expect(applyRelease(f.args, f.deps)).rejects.toMatchObject({
      code: 'DEPLOY_FAILED',
      status: 'rolled_back',
    })
    expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
    expect(f.calls).toEqual(['ensureInstalled', 'stop', 'start', 'stop', 'start'])
    const record = JSON.parse(await fs.readFile(join(f.root, 'last-deployment.json'), 'utf8'))
    expect(record.status).toBe('rolled_back')
    expect(record.previousRelease).toBe(f.previous)
    expect(f.requests.at(-1).url.origin).toBe('http://127.0.0.1:8787')
  },
)

test('failure to restart the old process is recorded as rollback_failed and never success', async () => {
  const f = await fixture({ failNewStart: true, failOldStart: true })
  await expect(applyRelease(f.args, f.deps)).rejects.toMatchObject({ status: 'rollback_failed' })
  expect(JSON.parse(await fs.readFile(join(f.root, 'last-deployment.json'), 'utf8')).status).toBe(
    'rollback_failed',
  )
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
})

test('an initial stop command failure still restores and checks the previous service', async () => {
  const f = await fixture()
  f.service.stop.mockRejectedValueOnce(Error('stop timed out after systemd accepted it'))
  await expect(applyRelease(f.args, f.deps)).rejects.toMatchObject({ status: 'rolled_back' })
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
  expect(f.service.stop).toHaveBeenCalledTimes(2)
  expect(f.service.start).toHaveBeenCalledTimes(1)
})

test('rollback requires the old health UUID, not merely a successful start command', async () => {
  const f = await fixture({ failNewStart: true })
  const originalFetch = f.deps.fetchFn
  let count = 0
  f.deps.fetchFn = async (...args) => {
    const response = await originalFetch(...args)
    if (++count === 1) return response
    const body = await response.json()
    body.data.version = id
    return Response.json(body)
  }
  await expect(applyRelease(f.args, f.deps)).rejects.toMatchObject({ status: 'rollback_failed' })
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
})

test('inability to persist rollback information aborts before stopping the old process', async () => {
  const f = await fixture()
  await fs.writeFile(join(f.root, 'deployments'), 'operator file, do not overwrite')
  await expect(applyRelease(f.args, f.deps)).rejects.toMatchObject({ status: 'preflight_failed' })
  expect(f.service.stop).not.toHaveBeenCalled()
  expect(await fs.readdir(join(f.root, 'releases'))).toEqual([oldId])
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
  expect(await fs.readFile(join(f.root, 'deployments'), 'utf8')).toBe(
    'operator file, do not overwrite',
  )
})

test('a stalled public response times out and restores the previous release without waiting for cancel', async () => {
  const f = await fixture()
  const originalFetch = f.deps.fetchFn
  f.deps.fetchFn = (url, init) =>
    new URL(url).pathname === '/version.json'
      ? Promise.resolve(
          new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      : originalFetch(url, init)
  await expect(applyRelease(f.args, { ...f.deps, requestTimeoutMs: 20 })).rejects.toMatchObject({
    status: 'rolled_back',
  })
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
})

test('a second deployment cannot enter while the first holds the filesystem lock', async () => {
  const f = await fixture()
  let entered, resume
  const ready = new Promise((done) => {
    entered = done
  })
  const gate = new Promise((done) => {
    resume = done
  })
  f.service.ensureInstalled.mockImplementationOnce(async () => {
    entered()
    await gate
  })
  const first = applyRelease(f.args, f.deps)
  await ready
  await expect(applyRelease(f.args, f.deps)).rejects.toHaveProperty('code', 'DEPLOY_LOCKED')
  resume()
  await expect(first).resolves.toHaveProperty('status', 'succeeded')
  expect(f.service.stop).toHaveBeenCalledTimes(1)
})

test('cancellation after stopping the service triggers the same verified rollback', async () => {
  const f = await fixture()
  const controller = new AbortController()
  f.service.stop.mockImplementationOnce(async () => {
    f.calls.push('stop')
    controller.abort()
  })
  await expect(
    applyRelease({ ...f.args, signal: controller.signal }, f.deps),
  ).rejects.toMatchObject({ status: 'rolled_back' })
  expect(await fs.realpath(join(f.root, 'current'))).toBe(f.previous)
})
