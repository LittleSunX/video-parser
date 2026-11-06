import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'
import { monitoringAssets, prepareMonitoring } from './install-vps-monitoring.mjs'

// Uploaded with install-vps-monitoring.mjs; both use only Node built-ins.
export const archiveLimits = {
  compressed: 64 * 1024 * 1024,
  extracted: 128 * 1024 * 1024,
  entries: 10_000,
}
export const rollbackExitCodes = { rolled_back: 72, rollback_failed: 73 }
const sha = (value) => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value)
const uuid = (value) =>
  typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)
const timestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
const decoder = new TextDecoder('utf-8', { fatal: true })
const onceInstalled =
  '请先完成 VPS_DEPLOY.md 第 1–7 节的一次性安装，确认 current、配套产物与 video-parser 服务就绪'

function failure(message, code = 'INVALID_RELEASE') {
  return Object.assign(new Error(message), { code })
}

export function validateArguments({ archive, sha256, site, commit }) {
  if (
    typeof archive !== 'string' ||
    !archive ||
    !/^[a-f\d]{64}$/i.test(sha256 ?? '') ||
    !sha(commit)
  )
    throw failure('必须指定 archive、64 位 sha256 和完整 commit', 'INVALID_ARGUMENTS')
  let url
  try {
    url = new URL(site)
  } catch {
    throw failure('site 必须为 HTTPS 站点根地址', 'INVALID_ARGUMENTS')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw failure('site 必须为不含凭据、路径、查询或片段的 HTTPS 根地址', 'INVALID_ARGUMENTS')
  return {
    archive: resolve(archive),
    sha256: sha256.toLowerCase(),
    site: url.origin,
    commit: commit.toLowerCase(),
  }
}

function text(buffer) {
  const zero = buffer.indexOf(0)
  return decoder.decode(zero < 0 ? buffer : buffer.subarray(0, zero))
}

function octal(buffer) {
  const value = text(buffer).trim()
  if (value && !/^[0-7]+$/.test(value)) throw failure('tar 数字字段无效', 'INVALID_ARCHIVE')
  const result = value ? Number.parseInt(value, 8) : 0
  if (!Number.isSafeInteger(result)) throw failure('tar 数字超限', 'INVALID_ARCHIVE')
  return result
}

function archivePath(name, directory) {
  if (directory && name.endsWith('/')) name = name.slice(0, -1)
  const parts = name.split('/')
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  )
    throw failure('tar 含不安全的条目路径', 'INVALID_ARCHIVE')
  if (
    !(name === 'frontend' && directory) &&
    !name.startsWith('frontend/') &&
    !(directory && name === 'server') &&
    !(directory && name === 'operations') &&
    !(!directory && monitoringAssets.some((asset) => name === 'operations/' + asset)) &&
    !(
      !directory && ['server/index.mjs', 'server/version.json', 'server/monitor.mjs'].includes(name)
    )
  )
    throw failure('tar 只能包含 frontend/ 与允许的 server、operations 产物', 'INVALID_ARCHIVE')
  return name
}

function paxFields(body) {
  const result = {}
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(32, offset)
    const lengthText = body.subarray(offset, space).toString('ascii')
    if (space < offset || !/^[1-9]\d{0,8}$/.test(lengthText))
      throw failure('PAX 记录无效', 'INVALID_ARCHIVE')
    const length = Number(lengthText)
    if (
      length <= space - offset + 2 ||
      offset + length > body.length ||
      body[offset + length - 1] !== 10
    )
      throw failure('PAX 长度无效', 'INVALID_ARCHIVE')
    const field = decoder.decode(body.subarray(space + 1, offset + length - 1))
    const equals = field.indexOf('=')
    if (equals < 1) throw failure('PAX 字段无效', 'INVALID_ARCHIVE')
    const key = field.slice(0, equals)
    if (key === 'linkpath') throw failure('tar 不允许链接', 'INVALID_ARCHIVE')
    // All other attributes (ownership, timestamps, xattrs) are deliberately ignored.
    if (key === 'path' || key === 'size') result[key] = field.slice(equals + 1)
    offset += length
  }
  return result
}

export function parseReleaseArchive(compressed, limits = archiveLimits) {
  if (compressed.length > limits.compressed) throw failure('压缩包超过 64 MiB', 'INVALID_ARCHIVE')
  let tar
  try {
    tar = gunzipSync(compressed, { maxOutputLength: limits.extracted })
  } catch {
    throw failure('gzip 无效或展开超过 128 MiB', 'INVALID_ARCHIVE')
  }
  const entries = new Map()
  let offset = 0,
    count = 0,
    pax,
    ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset).every((byte) => byte === 0))
        throw failure('tar 结束标记无效', 'INVALID_ARCHIVE')
      ended = true
      break
    }
    if (++count > limits.entries) throw failure('tar 条目超过上限', 'INVALID_ARCHIVE')
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (
      octal(header.subarray(148, 156)) !== checksum ||
      text(header.subarray(257, 263)).trim() !== 'ustar'
    )
      throw failure('tar 头校验失败或不是 ustar 格式', 'INVALID_ARCHIVE')
    const kind = header[156]
    const directory = kind === 53
    const extension = kind === 120
    if (kind !== 0 && kind !== 48 && !directory && !extension)
      throw failure('tar 不允许软链、硬链或特殊条目', 'INVALID_ARCHIVE')
    let size = octal(header.subarray(124, 136))
    if (!extension && pax?.size !== undefined) {
      if (!/^\d{1,12}$/.test(pax.size)) throw failure('PAX 大小无效', 'INVALID_ARCHIVE')
      size = Number(pax.size)
    }
    const next = offset + 512 + Math.ceil(size / 512) * 512
    if (size > limits.extracted || next > tar.length || (directory && size))
      throw failure('tar 条目被截断或大小无效', 'INVALID_ARCHIVE')
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (extension) {
      if (pax) throw failure('重复的 PAX 头', 'INVALID_ARCHIVE')
      pax = paxFields(body)
    } else {
      const prefix = text(header.subarray(345, 500))
      const name = archivePath(
        pax?.path ?? (prefix ? prefix + '/' : '') + text(header.subarray(0, 100)),
        directory,
      )
      if (entries.has(name)) throw failure('tar 含重复条目', 'INVALID_ARCHIVE')
      entries.set(name, { directory, body })
      pax = undefined
    }
    offset = next
  }
  if (!ended || pax) throw failure('tar 缺少完整结束标记', 'INVALID_ARCHIVE')
  for (const name of entries.keys()) {
    let parent = name
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'))
      if (entries.has(parent) && !entries.get(parent).directory)
        throw failure('tar 目录与文件冲突', 'INVALID_ARCHIVE')
    }
  }
  return entries
}

function versions(frontend, server, expected) {
  if (
    !sha(frontend?.commit) ||
    !timestamp(frontend?.builtAt) ||
    !sha(server?.tag) ||
    !uuid(server?.id) ||
    server?.runtime !== 'node' ||
    !timestamp(server?.timestamp) ||
    frontend.commit.toLowerCase() !== server.tag.toLowerCase() ||
    (expected && server.tag.toLowerCase() !== expected)
  )
    throw failure('前后端版本必须配套，且包含有效 SHA、构建时间及 Node 版本 UUID')
  return { frontend, server }
}

function json(buffer) {
  if (!buffer || buffer.length > 16 * 1024) throw failure('版本文件缺失或超过 16 KiB')
  try {
    return JSON.parse(decoder.decode(buffer))
  } catch {
    throw failure('版本文件不是有效 JSON')
  }
}

function archiveVersions(entries, commit) {
  for (const name of [
    'frontend/index.html',
    'server/index.mjs',
    'frontend/version.json',
    'server/version.json',
  ])
    if (!entries.get(name)?.body.length || entries.get(name).directory)
      throw failure('压缩包缺少必需的前后端构建产物')
  return versions(
    json(entries.get('frontend/version.json').body),
    json(entries.get('server/version.json').body),
    commit,
  )
}

async function regularFile(path, maxSize) {
  const before = await fs.lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw failure('发布文件必须是普通文件')
  const handle = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const info = await handle.stat()
    if (!info.isFile() || !info.size || info.size > maxSize) throw failure('发布文件类型或大小无效')
    const buffer = Buffer.alloc(Math.min(info.size, maxSize) + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!result.bytesRead) break
      bytes += result.bytesRead
    }
    if (bytes > info.size || bytes > maxSize) throw failure('发布文件读取期间增长或超过上限')
    return buffer.subarray(0, bytes)
  } finally {
    await handle.close()
  }
}

export async function readReleaseArchive(path, commit, expectedChecksum) {
  const archive = await regularFile(path, archiveLimits.compressed)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (expectedChecksum !== undefined && sha256 !== expectedChecksum)
    throw failure('压缩包 SHA256 校验失败', 'CHECKSUM_MISMATCH')
  const entries = parseReleaseArchive(archive)
  return { entries, versions: archiveVersions(entries, commit), sha256 }
}

async function installedVersions(directory) {
  for (const name of ['frontend', 'server']) {
    const info = await fs.lstat(join(directory, name))
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure(onceInstalled, 'NOT_INSTALLED')
  }
  for (const name of ['frontend/index.html', 'server/index.mjs']) {
    const info = await fs.lstat(join(directory, name))
    if (!info.isFile() || !info.size) throw failure(onceInstalled, 'NOT_INSTALLED')
  }
  return versions(
    json(await regularFile(join(directory, 'frontend/version.json'), 16 * 1024)),
    json(await regularFile(join(directory, 'server/version.json'), 16 * 1024)),
  )
}

async function directory(path) {
  const info = await fs.lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure(onceInstalled, 'NOT_INSTALLED')
}

async function lock(root) {
  const path = join(root, '.deploy.lock')
  let handle
  try {
    handle = await fs.open(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST')
      throw failure(
        '已有发布锁；请等待当前发布结束，异常中断后先检查部署记录再人工清理锁',
        'DEPLOY_LOCKED',
      )
    throw error
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
    )
  } catch (error) {
    await handle.close()
    await fs.unlink(path)
    throw error
  }
  return async () => {
    await handle.close()
    await fs.unlink(path)
  }
}

export async function replaceCurrent(root, target) {
  const temporary = join(root, '.current-' + randomUUID())
  await fs.symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await fs.rename(temporary, join(root, 'current'))
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function writeRecord(root, record) {
  const folder = join(root, 'deployments')
  await fs.mkdir(folder, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  await directory(folder)
  const content = JSON.stringify(record, null, 2) + '\n'
  for (const path of [
    join(folder, record.transaction + '.json'),
    join(root, 'last-deployment.json'),
  ]) {
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, path)
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}

export function systemService() {
  const run = promisify(execFile)
  const command = (args) =>
    run('/usr/bin/systemctl', args, { timeout: 40_000, maxBuffer: 16 * 1024 })
  return {
    async ensureInstalled() {
      try {
        const result = await command([
          'show',
          'video-parser.service',
          '--property=LoadState',
          '--value',
        ])
        if (result.stdout.trim() !== 'loaded') throw new Error()
        await command(['is-active', '--quiet', 'video-parser.service'])
      } catch {
        throw failure(onceInstalled, 'NOT_INSTALLED')
      }
    },
    async stop() {
      try {
        await command(['stop', 'video-parser.service'])
      } catch {
        throw failure('无法停止 video-parser 服务', 'SERVICE_FAILED')
      }
    },
    async start() {
      try {
        await command(['start', 'video-parser.service'])
      } catch {
        throw failure('无法启动 video-parser 服务', 'SERVICE_FAILED')
      }
    },
  }
}

async function readJsonResponse(url, fetchFn, timeout, parentSignal) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(parentSignal ? [parentSignal] : []),
  ])
  let response, reader
  try {
    response = await fetchFn(url, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      cache: 'no-store',
      redirect: 'error',
      signal,
    })
    if (
      !response.ok ||
      !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')
    )
      throw new Error()
    reader = response.body?.getReader()
    if (!reader) throw new Error()
    let bytes = 0,
      value = ''
    const decode = new TextDecoder('utf-8', { fatal: true })
    while (true) {
      const chunk = await new Promise((resolveRead, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        reader
          .read()
          .then(resolveRead, reject)
          .finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
      })
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 16 * 1024) throw new Error()
      value += decode.decode(chunk.value, { stream: true })
    }
    return JSON.parse(value + decode.decode())
  } catch {
    throw failure('健康或版本响应无效、超时或不匹配', 'VERIFY_FAILED')
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    } else void response?.body?.cancel().catch(() => {})
  }
}

function healthy(body, expected) {
  const data = body?.success === true ? body.data : undefined
  return (
    data?.service === 'video-parser-api' &&
    data.status === 'ok' &&
    data.runtime === 'node' &&
    data.version === expected.id &&
    data.versionTag === expected.tag &&
    data.versionCreatedAt === expected.timestamp
  )
}

async function verify(base, path, expected, deps, signal) {
  for (let attempt = 0; attempt < deps.pollAttempts; attempt++) {
    signal?.throwIfAborted()
    try {
      const url = new URL(path, base + '/')
      url.searchParams.set('release', expected.server.id)
      url.searchParams.set('check', randomUUID())
      const body = await readJsonResponse(url.href, deps.fetchFn, deps.requestTimeoutMs, signal)
      if (
        path === 'api/health'
          ? healthy(body, expected.server)
          : body?.commit === expected.frontend.commit && body?.builtAt === expected.frontend.builtAt
      )
        return
    } catch {
      signal?.throwIfAborted()
    }
    if (attempt + 1 < deps.pollAttempts)
      await new Promise((done) => setTimeout(done, deps.pollIntervalMs))
  }
  throw failure('健康或版本响应无效、超时或不匹配', 'VERIFY_FAILED')
}

async function materialize(entries, target) {
  await fs.chmod(target, 0o755)
  for (const [name, entry] of entries) {
    const destination = join(target, ...name.split('/'))
    await fs.mkdir(entry.directory ? destination : dirname(destination), {
      recursive: true,
      mode: 0o755,
    })
    if (!entry.directory) {
      await fs.writeFile(destination, entry.body, { flag: 'wx', mode: 0o644 })
      await fs.chmod(destination, 0o644)
    }
  }
  // Correct umask-created intermediate directories so Nginx and the service can read them.
  const directories = new Set()
  for (const name of entries.keys()) {
    const parts = name.split('/')
    if (!entries.get(name).directory) parts.pop()
    while (parts.length) {
      directories.add(join(target, ...parts))
      parts.pop()
    }
  }
  for (const path of directories) await fs.chmod(path, 0o755)
}

async function requireUnusedRelease(release) {
  // The deployment lock serializes publishers. Preserve even an empty existing release.
  try {
    await fs.lstat(release)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw failure('新 release 目录已存在；不会覆盖任何已有版本', 'RELEASE_EXISTS')
}

/** All preparatory work happens before stop; any later error restores the previous pair. */
export async function applyRelease(args, overrides = {}) {
  const input = validateArguments(args)
  const deps = {
    root: '/opt/video-parser',
    service: systemService(),
    prepareMonitoring,
    fetchFn: globalThis.fetch,
    switchCurrent: replaceCurrent,
    pollAttempts: 15,
    pollIntervalMs: 500,
    requestTimeoutMs: 3000,
    ...overrides,
  }
  const root = resolve(deps.root)
  try {
    await directory(root)
    await directory(join(root, 'releases'))
  } catch {
    throw failure(onceInstalled, 'NOT_INSTALLED')
  }
  const releaseLock = await lock(root)
  let record,
    staging,
    monitoring,
    mutationStarted = false
  try {
    let previous, old
    try {
      if (!(await fs.lstat(join(root, 'current'))).isSymbolicLink()) throw new Error()
      previous = await fs.realpath(join(root, 'current'))
      if (dirname(previous) !== (await fs.realpath(join(root, 'releases')))) throw new Error()
      old = await installedVersions(previous)
      await deps.service.ensureInstalled()
      await verify('http://127.0.0.1:8787', 'api/health', old, deps, args.signal)
    } catch {
      throw failure(onceInstalled, 'NOT_INSTALLED')
    }
    args.signal?.throwIfAborted()
    const { entries, versions: next } = await readReleaseArchive(
      input.archive,
      input.commit,
      input.sha256,
    )
    const release = join(root, 'releases', next.server.id.toLowerCase())
    await requireUnusedRelease(release)
    staging = await fs.mkdtemp(join(dirname(release), '.staging-'))
    await materialize(entries, staging)
    monitoring = await deps.prepareMonitoring(entries, { root })
    record = {
      transaction: randomUUID(),
      status: 'prepared',
      commit: input.commit,
      releaseId: next.server.id,
      release,
      previousRelease: previous,
      previousCommit: old.server.tag,
      previousReleaseId: old.server.id,
      startedAt: new Date().toISOString(),
    }
    await writeRecord(root, record)
    args.signal?.throwIfAborted()
    record.status = 'switching'
    await writeRecord(root, record)
    args.signal?.throwIfAborted()
    await fs.rename(staging, release)
    staging = undefined
    mutationStarted = true
    await deps.service.stop()
    await monitoring?.install()
    args.signal?.throwIfAborted()
    await deps.switchCurrent(root, release)
    await deps.service.start()
    args.signal?.throwIfAborted()
    await verify('http://127.0.0.1:8787', 'api/health', next, deps, args.signal)
    await verify(input.site, 'version.json', next, deps, args.signal)
    await verify(input.site, 'api/health', next, deps, args.signal)
    await monitoring?.verify(next.server.id)
    args.signal?.throwIfAborted()
    record.status = 'succeeded'
    record.monitoring = monitoring ? 'verified' : 'unchanged'
    record.completedAt = new Date().toISOString()
    await writeRecord(root, record)
    return { passed: true, ...record }
  } catch (error) {
    if (record) {
      if (mutationStarted) {
        try {
          // Retry stop even if the first stop/start command failed partway through.
          await deps.service.stop().catch(() => {})
          let monitoringRestored = true
          await monitoring?.rollback().catch(() => {
            monitoringRestored = false
          })
          await deps.switchCurrent(root, record.previousRelease)
          await deps.service.start()
          const old = await installedVersions(record.previousRelease)
          await verify('http://127.0.0.1:8787', 'api/health', old, deps)
          if (!monitoringRestored) throw new Error('Monitoring rollback failed', { cause: error })
          record.status = 'rolled_back'
        } catch {
          record.status = 'rollback_failed'
        }
      } else record.status = 'preflight_failed'
      record.completedAt = new Date().toISOString()
      await writeRecord(root, record).catch(() => {})
      throw Object.assign(
        failure(
          record.status === 'rolled_back'
            ? '发布失败，已恢复并核对上一版本；请检查部署记录'
            : record.status === 'rollback_failed'
              ? '发布失败且自动恢复未通过，请立即按部署记录人工恢复上一版本'
              : '发布准备失败，旧版本未切换',
          'DEPLOY_FAILED',
        ),
        { status: record.status, record, cause: error },
      )
    }
    throw error
  } finally {
    try {
      if (staging) await fs.rm(staging, { recursive: true, force: true })
    } finally {
      await releaseLock()
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      '用法：sudo node apply-vps-release.mjs --archive release.tar.gz --sha256 <64hex> --site https://example.com --commit <40hex>\n仅更新已按 VPS_DEPLOY.md 配置的 Node + Nginx + systemd 单实例。',
    )
    return
  }
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].slice(2),
      value = args[index + 1]
    if (
      !args[index].startsWith('--') ||
      !['archive', 'sha256', 'site', 'commit'].includes(key) ||
      Object.hasOwn(values, key) ||
      !value ||
      value.startsWith('--')
    )
      throw failure('发布参数无效；使用 --help 查看用法', 'INVALID_ARGUMENTS')
    values[key] = value
  }
  validateArguments(values)
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw failure('真实发布仅支持 Linux，并须通过 sudo 以 root 运行', 'PLATFORM_UNSUPPORTED')
  const cancellation = new AbortController()
  const cancel = () => cancellation.abort(failure('发布被中断', 'CANCELLED'))
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    console.log(
      JSON.stringify(await applyRelease({ ...values, signal: cancellation.signal }), null, 2),
    )
  } finally {
    process.off('SIGINT', cancel)
    process.off('SIGTERM', cancel)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        passed: false,
        status: error.status ?? 'preflight_failed',
        code: error.code ?? 'DEPLOY_FAILED',
        message: error.code ? error.message : '发布失败，请检查文件权限与部署记录',
        ...(error.record
          ? {
              release: error.record.release,
              previousRelease: error.record.previousRelease,
              commit: error.record.commit,
            }
          : {}),
      }),
    )
    process.exitCode = rollbackExitCodes[error.status] ?? 1
  })
}
