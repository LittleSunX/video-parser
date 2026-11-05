import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { readReleaseArchive, rollbackExitCodes } from '../deploy/apply-vps-release.mjs'
import { checkRelease } from './check-release.mjs'
import {
  cli,
  gitState,
  isMain,
  isTimestamp,
  isUuid,
  options,
  readJson,
  report,
  repositoryRoot,
  requireCommit,
} from './release-utils.mjs'

const fields = new Set(['host', 'user', 'port', 'site', 'identityFile', 'knownHostsFile'])
const filePath = (value, base) => {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value))
    throw new Error('SSH key and known_hosts file paths are required')
  return resolve(base, value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)
}

export function validateVpsConfig(value, base = repositoryRoot) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('VPS config must be a JSON object')
  if (Object.keys(value).some((key) => !fields.has(key)))
    throw new Error('Unknown VPS config field; passwords and shell commands are not supported')
  if (
    typeof value.host !== 'string' ||
    value.host.length > 253 ||
    (!isIP(value.host) && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value.host))
  )
    throw new Error('VPS host must be an IP address or DNS hostname')
  if (typeof value.user !== 'string' || !/^[a-z_][a-z\d_-]{0,31}$/i.test(value.user))
    throw new Error('Invalid SSH user')
  const port = value.port ?? 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port')
  let site
  try {
    site = new URL(value.site)
  } catch {
    throw new Error('VPS site must be an HTTPS root URL')
  }
  if (
    site.protocol !== 'https:' ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== '/'
  )
    throw new Error('VPS site must be an HTTPS root URL without credentials or query')
  return {
    host: value.host,
    user: value.user,
    port,
    site: site.origin,
    identityFile: filePath(value.identityFile, base),
    knownHostsFile: filePath(value.knownHostsFile, base),
  }
}

export function shellQuote(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('Invalid remote command argument')
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

export function sshConnection(config, scp = false) {
  const host = scp && isIP(config.host) === 6 ? `[${config.host}]` : config.host
  const knownHosts =
    process.platform === 'win32'
      ? config.knownHostsFile.replaceAll('\\', '/')
      : config.knownHostsFile
  const quotedKnownHosts = '"' + knownHosts.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
  return {
    target: `${config.user}@${host}`,
    args: [
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${quotedKnownHosts}`,
      '-i',
      config.identityFile,
      scp ? '-P' : '-p',
      String(config.port),
    ],
  }
}

export function vpsDeploymentPlan(state, config, deploy = false) {
  const commit = requireCommit(state.commit)
  if (typeof state.dirty !== 'boolean') throw new Error('Unable to verify Git state')
  if (deploy && state.dirty)
    throw new Error('Commit all source changes before deploying; docs/ may remain ignored')
  return {
    mode: deploy ? 'deploy' : 'preview',
    commit,
    dirty: state.dirty,
    ...(!deploy && process.env.GITHUB_ACTIONS !== 'true'
      ? { host: config.host, user: config.user, port: config.port, site: config.site }
      : {}),
    runtime: 'node',
    root: '/opt/video-parser',
    service: 'video-parser',
  }
}

export function vpsBuildEnvironment(env = process.env) {
  const buildEnv = { ...env, VITE_API_BASE_URL: '/' }
  delete buildEnv.VERCEL_GIT_COMMIT_SHA
  return buildEnv
}

async function jsonFile(path) {
  const data = await readFile(path)
  if (data.byteLength > 16 * 1024) throw new Error('Version metadata is too large')
  return JSON.parse(data.toString('utf8'))
}

export async function inspectVpsArtifacts(root, expected) {
  const commit = requireCommit(expected)
  const front = await jsonFile(join(root, 'frontend/dist/version.json'))
  const api = await jsonFile(join(root, 'server/dist/version.json'))
  if (
    front.commit !== commit ||
    api.tag !== commit ||
    api.runtime !== 'node' ||
    !isUuid(api.id) ||
    !isTimestamp(front.builtAt) ||
    !isTimestamp(api.timestamp)
  )
    throw new Error('Frontend and Node artifacts must match this commit and build metadata')
  for (const file of ['frontend/dist/index.html', 'server/dist/index.mjs']) {
    if (!(await stat(join(root, file))).size) throw new Error('Missing build artifact: ' + file)
  }
  return { commit, releaseId: api.id, frontendBuiltAt: front.builtAt }
}

async function validateTree(directory) {
  let files = 0,
    bytes = 0
  async function visit(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('Build artifacts must not contain symbolic links')
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        if (!/^[a-z\d_.-]+$/i.test(name) || name === '.' || name === '..')
          throw new Error('Unsupported build artifact name')
        await visit(join(path, name))
      }
    } else if (info.isFile()) {
      files++
      bytes += info.size
      if (files > 10_000 || bytes > 128 * 1024 * 1024)
        throw new Error('Build artifacts exceed the VPS release budget')
    } else throw new Error('Build artifacts must contain only regular files and directories')
  }
  await visit(directory)
}

export function runCommand(
  binary,
  args,
  { cwd = repositoryRoot, env = process.env, timeout = 600_000 } = {},
) {
  return new Promise((resolve, reject) => {
    // SSH diagnostics can include resolved IPs and normalized hostnames that a CI mask misses.
    const privateTransport =
      process.env.GITHUB_ACTIONS === 'true' && ['ssh', 'scp'].includes(binary)
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: privateTransport ? 'ignore' : 'inherit',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${basename(binary)} exceeded its deadline`))
    }, timeout)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else
        reject(
          Object.assign(new Error(`${basename(binary)} failed (${code ?? 'signal'})`), {
            exitCode: code,
          }),
        )
    })
  })
}

export async function createVpsArchive(root, directory, commit, run = runCommand) {
  const metadata = await inspectVpsArtifacts(root, commit)
  const stage = join(directory, 'package')
  await validateTree(join(root, 'frontend/dist'))
  await validateTree(join(root, 'server/dist'))
  await cp(join(root, 'frontend/dist'), join(stage, 'frontend'), { recursive: true })
  await cp(join(root, 'server/dist/index.mjs'), join(stage, 'server/index.mjs'))
  await cp(join(root, 'server/dist/version.json'), join(stage, 'server/version.json'))
  const archive = join(directory, 'release.tar.gz')
  await run('tar', ['--format=ustar', '-czf', archive, '-C', stage, 'frontend', 'server'])
  const data = await readFile(archive)
  if (data.byteLength > 64 * 1024 * 1024) throw new Error('Compressed release exceeds 64 MiB')
  return { ...metadata, archive, sha256: createHash('sha256').update(data).digest('hex') }
}

async function cleanTemporary(directory) {
  const path = resolve(directory)
  if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('video-parser-vps-'))
    throw new Error('Refusing to clean an unexpected temporary directory')
  await rm(path, { recursive: true, force: true })
}

async function prepareBundle(commit, temporary, bundleDirectory, run) {
  if (bundleDirectory) {
    const archive = resolve(bundleDirectory, 'release.tar.gz')
    const { sha256, versions } = await readReleaseArchive(archive, commit)
    return {
      archive,
      sha256,
      releaseId: versions.server.id,
      frontendBuiltAt: versions.frontend.builtAt,
    }
  }
  if (process.env.GITHUB_ACTIONS === 'true')
    throw new Error('Actions deployments require a release archive from the build job')
  const npmCli = process.env.npm_execpath
  if (!npmCli && process.platform === 'win32')
    throw new Error('Run this command through npm run deploy:vps')
  await run(
    npmCli ? process.execPath : 'npm',
    npmCli ? [npmCli, 'run', 'check'] : ['run', 'check'],
    { env: vpsBuildEnvironment() },
  )
  const current = gitState()
  if (current.commit !== commit || current.dirty)
    throw new Error('Git source changed during the build; no files were uploaded')
  return createVpsArchive(repositoryRoot, temporary, commit, run)
}

export async function deployVps(config, state, run = runCommand, bundleDirectory) {
  const plan = vpsDeploymentPlan(state, config, true)
  for (const path of [config.identityFile, config.knownHostsFile])
    if (!(await stat(path)).isFile()) throw new Error('Missing SSH key or trusted known_hosts file')
  const ssh = sshConnection(config)
  const scp = sshConnection(config, true)
  // Discover incomplete first-time setup before spending time building or uploading.
  try {
    await run(
      'ssh',
      [
        ...ssh.args,
        ssh.target,
        'test -x /usr/bin/node && test -L /opt/video-parser/current && systemctl cat video-parser.service >/dev/null',
      ],
      { timeout: 30_000 },
    )
  } catch {
    throw new Error(
      'VPS preflight failed: check SSH trust/key and the one-time Node/Nginx/systemd setup in guides/vps-one-click.md',
    )
  }
  const temporary = await mkdtemp(join(tmpdir(), 'video-parser-vps-'))
  const remote = `video-parser-upload/${randomUUID()}`
  let uploaded = false
  try {
    const bundle = await prepareBundle(plan.commit, temporary, bundleDirectory, run)
    await run('ssh', [...ssh.args, ssh.target, `umask 077 && mkdir -p -- ${shellQuote(remote)}`], {
      timeout: 30_000,
    })
    uploaded = true
    await run(
      'scp',
      [
        ...scp.args,
        bundle.archive,
        join(repositoryRoot, 'deploy/apply-vps-release.mjs'),
        `${scp.target}:${remote}/`,
      ],
      { timeout: 120_000 },
    )
    const command = [
      ...(config.user === 'root' ? [] : ['sudo', '-n']),
      '/usr/bin/node',
      './apply-vps-release.mjs',
      '--archive',
      './release.tar.gz',
      '--sha256',
      bundle.sha256,
      '--site',
      config.site,
      '--commit',
      plan.commit,
    ]
      .map(shellQuote)
      .join(' ')
    await run('ssh', [...ssh.args, ssh.target, `cd ${shellQuote(remote)} && ${command}`], {
      timeout: 600_000,
    }).catch((error) => {
      if (error.exitCode === rollbackExitCodes.rolled_back)
        throw new Error('Deployment failed; previous release restored and checked')
      if (error.exitCode === rollbackExitCodes.rollback_failed)
        throw new Error(
          'Automatic rollback failed; inspect the server deployment record immediately',
        )
      throw error
    })
    const verified = await checkRelease({
      frontend: config.site,
      api: config.site,
      commit: plan.commit,
      expectedNodeBuild: bundle,
    })
    if (!verified.passed)
      throw new Error(
        'Server deployment finished, but external version verification failed; inspect the saved server release record',
      )
    return {
      ...plan,
      passed: true,
      ...(process.env.GITHUB_ACTIONS === 'true' ? {} : { releaseId: bundle.releaseId }),
    }
  } finally {
    if (uploaded) {
      const files = ['release.tar.gz', 'apply-vps-release.mjs'].map((file) =>
        shellQuote(remote + '/' + file),
      )
      await run(
        'ssh',
        [...ssh.args, ssh.target, `rm -f -- ${files.join(' ')} && rmdir -- ${shellQuote(remote)}`],
        { timeout: 30_000 },
      ).catch(() =>
        console.error('Temporary upload cleanup failed; the active release is unaffected'),
      )
    }
    await cleanTemporary(temporary)
  }
}

export async function main(args = process.argv.slice(2)) {
  const flags = options(args, {
    help: 'boolean',
    config: 'string',
    deploy: 'boolean',
    bundle: 'string',
  })
  if (flags.help) {
    console.log(
      'Usage: npm run deploy:vps -- --config <local JSON file> [--deploy [--bundle <directory with release.tar.gz>]]\nWithout --deploy this only previews the target. First-time Node/Nginx/systemd and SSH setup are required; see guides/vps-one-click.md.',
    )
    return
  }
  if (!flags.config)
    throw new Error('Provide a local VPS config with --config; see guides/vps-one-click.md')
  if (flags.bundle && !flags.deploy) throw new Error('--bundle requires --deploy')
  const path = resolve(flags.config)
  const raw = await readJson(
    new Response(await readFile(path), { headers: { 'Content-Type': 'application/json' } }),
    { maxBytes: 16 * 1024 },
  )
  const config = validateVpsConfig(raw, dirname(path))
  const state = gitState()
  report(vpsDeploymentPlan(state, config, flags.deploy))
  if (flags.deploy) report(await deployVps(config, state, runCommand, flags.bundle))
}

if (isMain(import.meta.url)) await cli(() => main())
