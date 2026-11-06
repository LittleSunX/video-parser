import { afterEach, expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseReleaseArchive } from '../deploy/apply-vps-release.mjs'
import { monitoringAssets } from '../deploy/install-vps-monitoring.mjs'
import {
  createVpsArchive,
  deployVps,
  inspectVpsArtifacts,
  shellQuote,
  sshConnection,
  validateVpsConfig,
  vpsBuildEnvironment,
  vpsDeploymentPlan,
} from '../scripts/deploy-vps.mjs'

const commit = 'a'.repeat(40)
const uuid = '11111111-2222-4333-8444-555555555555'
const timestamp = '2026-11-05T00:00:00.000Z'
const config = {
  host: 'vps.example.com',
  user: 'deploy',
  site: 'https://example.com',
  identityFile: './deploy-key',
  knownHostsFile: './known_hosts',
}
const directories = []
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'video-parser-vps-test-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) {
    const path = resolve(directory)
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('video-parser-vps-test-'))
      throw new Error('Unexpected temporary test directory')
    await rm(path, { recursive: true, force: true })
  }
})

async function artifacts(directory, overrides = {}) {
  await mkdir(join(directory, 'frontend/dist/assets'), { recursive: true })
  await mkdir(join(directory, 'server/dist'), { recursive: true })
  await writeFile(join(directory, 'frontend/dist/index.html'), '<html>fixture</html>')
  await writeFile(join(directory, 'frontend/dist/assets/app.js'), 'fixture application')
  await writeFile(
    join(directory, 'frontend/dist/version.json'),
    JSON.stringify({ commit, builtAt: timestamp }),
  )
  await writeFile(join(directory, 'server/dist/index.mjs'), 'fixture backend')
  await writeFile(join(directory, 'server/dist/monitor.mjs'), 'fixture monitor')
  await mkdir(join(directory, 'deploy'))
  for (const name of monitoringAssets)
    await writeFile(
      join(directory, 'deploy', name),
      await readFile(new URL('../deploy/' + name, import.meta.url)),
    )
  await writeFile(
    join(directory, 'server/dist/version.json'),
    JSON.stringify({ runtime: 'node', tag: commit, id: uuid, timestamp, ...overrides }),
  )
}

test('VPS config resolves SSH files relative to the config and keeps a same-origin public site', () => {
  const base = resolve('fixture')
  expect(validateVpsConfig(config, base)).toEqual({
    ...config,
    port: 22,
    identityFile: join(base, 'deploy-key'),
    knownHostsFile: join(base, 'known_hosts'),
  })
  expect(validateVpsConfig({ ...config, host: '2001:db8::1', port: 2222 }).port).toBe(2222)
})

test.each([
  { host: '-oProxyCommand=PRIVATE' },
  { host: 'example.com;echo PRIVATE' },
  { host: 'example.com\nPRIVATE' },
  { user: 'root;echo PRIVATE' },
  { port: '22' },
  { port: 0 },
  { site: 'https://user:PRIVATE@example.com' },
  { site: 'https://example.com/api' },
  { site: 'https://example.com?token=PRIVATE' },
  { site: 'http://example.com' },
  { identityFile: 'key\nPRIVATE' },
  { password: 'PRIVATE_PASSWORD' },
])('unsafe or ambiguous deployment configuration is rejected: %j', (fields) => {
  expect(() => validateVpsConfig({ ...config, ...fields })).toThrow()
})

test('SSH pins the trusted host key and uses argument arrays, including IPv6 scp destinations', () => {
  const value = validateVpsConfig({ ...config, host: '2001:db8::1', port: 2222 })
  const ssh = sshConnection(value)
  const scp = sshConnection(value, true)
  expect(ssh.target).toBe('deploy@2001:db8::1')
  expect(scp.target).toBe('deploy@[2001:db8::1]')
  expect(ssh.args).toContain('StrictHostKeyChecking=yes')
  expect(ssh.args).toContain('BatchMode=yes')
  expect(ssh.args).toContain('IdentitiesOnly=yes')
  expect(ssh.args.find((arg) => arg.startsWith('UserKnownHostsFile='))).toMatch(
    /^UserKnownHostsFile=".*"$/,
  )
  expect(scp.args.slice(-2)).toEqual(['-P', '2222'])
  expect(shellQuote("https://example.com/a'b")).toBe("'https://example.com/a'\\''b'")
  expect(() => shellQuote('a\nb')).toThrow()
})

test('deploy rejects dirty source while preview stays local and build uses this Git commit', () => {
  const target = validateVpsConfig(config)
  expect(vpsDeploymentPlan({ commit, dirty: true }, target).mode).toBe('preview')
  expect(() => vpsDeploymentPlan({ commit, dirty: true }, target, true)).toThrow('Commit')
  expect(vpsDeploymentPlan({ commit, dirty: false }, target, true)).toMatchObject({
    mode: 'deploy',
    commit,
    runtime: 'node',
    root: '/opt/video-parser',
    service: 'video-parser',
  })
  const env = {
    VERCEL_GIT_COMMIT_SHA: 'old',
    VITE_API_BASE_URL: 'https://old-worker.example.com',
    PATH: 'fixture',
  }
  const build = vpsBuildEnvironment(env)
  expect(build).toEqual({ VITE_API_BASE_URL: '/', PATH: 'fixture' })
  expect(env.VERCEL_GIT_COMMIT_SHA).toBe('old')
})

test.each([
  { tag: 'b'.repeat(40) },
  { runtime: 'cloudflare-worker' },
  { id: 'not-a-uuid' },
  { timestamp: '2026-13-30T00:00:00Z' },
])('stale or malformed Node metadata cannot be packaged: %j', async (metadata) => {
  const directory = await temporary()
  await artifacts(directory, metadata)
  await expect(inspectVpsArtifacts(directory, commit)).rejects.toThrow('artifacts must match')
})

test('real ustar archive contains paired builds and excludes source, notes and credentials', async () => {
  const directory = await temporary()
  await artifacts(directory)
  await mkdir(join(directory, 'docs'))
  await writeFile(join(directory, 'docs/private.json'), 'PRIVATE_NOTES')
  await writeFile(join(directory, '.env'), 'PRIVATE_CREDENTIAL')
  const output = await temporary()
  const bundle = await createVpsArchive(directory, output, commit)
  expect(bundle).toMatchObject({ commit, releaseId: uuid })
  expect(bundle.sha256).toMatch(/^[a-f0-9]{64}$/)
  const tar = gunzipSync(await readFile(bundle.archive)).toString('utf8')
  const entries = parseReleaseArchive(await readFile(bundle.archive))
  expect(entries.get('frontend/assets/app.js').body.toString()).toBe('fixture application')
  expect(JSON.parse(entries.get('server/version.json').body.toString()).tag).toBe(commit)
  expect(tar).toContain('frontend/assets/app.js')
  expect(tar).toContain('server/index.mjs')
  expect(entries.get('server/monitor.mjs').body.toString()).toBe('fixture monitor')
  for (const name of monitoringAssets)
    expect(entries.get('operations/' + name).body.length).toBeGreaterThan(0)
  expect(tar).toContain('fixture backend')
  expect(tar).not.toMatch(/PRIVATE_NOTES|PRIVATE_CREDENTIAL|private.json|\.env/)
})

test('new release packaging cannot silently omit the monitor', async () => {
  const directory = await temporary()
  await artifacts(directory)
  await rm(join(directory, 'server/dist/monitor.mjs'))
  await expect(createVpsArchive(directory, await temporary(), commit)).rejects.toThrow()
})

test('symbolic links in generated artifacts cannot escape the release package', async () => {
  const directory = await temporary()
  const outside = await temporary()
  await artifacts(directory)
  await writeFile(join(outside, 'private.txt'), 'PRIVATE')
  await symlink(
    outside,
    join(directory, 'frontend/dist/escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await expect(createVpsArchive(directory, await temporary(), commit)).rejects.toThrow(
    'symbolic links',
  )
})

test('CLI preview needs no SSH files or network and does not print rejected secret fields', async () => {
  const directory = await temporary()
  const path = join(directory, 'config.json')
  const script = fileURLToPath(new URL('../scripts/deploy-vps.mjs', import.meta.url))
  await writeFile(path, JSON.stringify(config))
  const preview = spawnSync(process.execPath, [script, '--config', path], {
    env: { ...process.env, GITHUB_ACTIONS: 'false' },
    encoding: 'utf8',
    timeout: 15_000,
  })
  expect(preview.status, preview.stderr).toBe(0)
  expect(JSON.parse(preview.stdout)).toMatchObject({
    mode: 'preview',
    site: 'https://example.com',
    runtime: 'node',
  })
  await writeFile(path, JSON.stringify({ ...config, password: 'PRIVATE_SECRET' }))
  const rejected = spawnSync(process.execPath, [script, '--config', path], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  expect(rejected.status).toBe(1)
  expect(rejected.stdout + rejected.stderr).not.toContain('PRIVATE_SECRET')
})

test('Actions preview and failing SSH diagnostics do not print the normalized target', async () => {
  const directory = await temporary()
  const path = join(directory, 'config.json')
  const script = new URL('../scripts/deploy-vps.mjs', import.meta.url)
  const site = 'https://Private-Site.example/'
  await writeFile(path, JSON.stringify({ ...config, site }))
  const options = {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  }
  const preview = spawnSync(process.execPath, [fileURLToPath(script), '--config', path], options)
  expect(preview.status, preview.stderr).toBe(0)
  const plan = JSON.parse(preview.stdout)
  for (const field of ['site', 'host', 'user', 'port']) expect(plan).not.toHaveProperty(field)
  // An invalid option makes OpenSSH print its input and exit before opening a connection.
  const command = `import {runCommand} from ${JSON.stringify(script.href)}; await runCommand('ssh', ['-o', 'Private-Site.example=yes']).catch(e => { console.error(e.message); process.exitCode = 1 })`
  const failure = spawnSync(process.execPath, ['--input-type=module', '-e', command], options)
  expect(failure.status).toBe(1)
  expect(failure.stderr).toContain('ssh failed')
  expect(preview.stdout + preview.stderr + failure.stdout + failure.stderr).not.toMatch(
    /private-site|vps\.example/i,
  )
})

test.each([
  ['this build', 'node', uuid, timestamp, true],
  ['a Worker at the same commit', 'cloudflare-worker', uuid, timestamp, false],
  [
    'a previous Node build at the same commit',
    'node',
    '91111111-2222-4333-8444-555555555555',
    timestamp,
    false,
  ],
  ['a previous frontend at the same commit', 'node', uuid, '2026-11-04T00:00:00.000Z', false],
])(
  'Actions deploys the prebuilt archive and checks %s',
  async (_, runtime, version, builtAt, passes) => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const root = await temporary()
    await artifacts(root)
    const bundleDir = await temporary()
    const bundle = await createVpsArchive(root, bundleDir, commit)
    const target = validateVpsConfig(config, root)
    await writeFile(target.identityFile, 'fixture')
    await writeFile(target.knownHostsFile, 'fixture')
    vi.stubGlobal('fetch', async (url) =>
      Response.json(
        new URL(url).pathname === '/version.json'
          ? { commit, builtAt }
          : {
              success: true,
              data: {
                service: 'video-parser-api',
                status: 'ok',
                runtime,
                version,
                versionTag: commit,
                versionCreatedAt: timestamp,
              },
            },
      ),
    )
    const run = vi.fn(async () => {})
    const result = deployVps(target, { commit, dirty: false }, run, bundleDir)
    if (passes) {
      const report = await result
      expect(report.passed).toBe(true)
      for (const field of ['host', 'site', 'port', 'user', 'releaseId'])
        expect(report).not.toHaveProperty(field)
    } else {
      await expect(result).rejects.toThrow('external version verification failed')
    }
    expect(run.mock.calls.map(([binary]) => binary)).toEqual(['ssh', 'ssh', 'scp', 'ssh', 'ssh'])
    expect(run.mock.calls[2][1]).toContain(bundle.archive)
    expect(run.mock.calls[2][1]).toContain(
      fileURLToPath(new URL('../deploy/apply-vps-release.mjs', import.meta.url)),
    )
    expect(run.mock.calls[3][1].at(-1)).toContain(bundle.sha256)
  },
)
