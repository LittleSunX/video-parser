import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import net from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const repository = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)
const command = (name, args) => execute(name, args, { timeout: 60_000, maxBuffer: 128 * 1024 })
const systemctl = (...args) => command('/usr/bin/systemctl', args)

async function freePort() {
  const socket = net.createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolve)
  })
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

/** Exercise the real unit's DynamicUser, credentials and journal access in an isolated namespace. */
export async function checkMonitoringSystemd({
  templatePath = join(repository, 'deploy/video-parser-monitor.service'),
} = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error('Requires root on Linux with a running systemd manager')
  const machine = (await fs.readFile('/etc/machine-id', 'utf8')).trim()
  assert.match(machine, /^[a-f0-9]{32}$/)
  const directory = await fs.mkdtemp('/run/video-parser-monitor-check-')
  assert.equal(dirname(directory), '/run')
  assert.ok(basename(directory).startsWith('video-parser-monitor-check-'))
  await fs.chmod(directory, 0o755)
  const namespace = basename(directory)
  const api = namespace + '-api.service'
  const monitor = namespace + '-monitor.service'
  const state = namespace + '-state'
  const lock = namespace + '-lock'
  const port = await freePort()
  const healthUrl = `http://127.0.0.1:${port}/api/health`
  const cleanup = [
    join('/run/systemd/system', api),
    join('/run/systemd/system', monitor),
    join('/var/lib', state),
    join('/var/lib/private', state),
    join('/run', lock),
    join('/run/private', lock),
    join('/var/log/journal', machine + '.' + namespace),
    join('/run/log/journal', machine + '.' + namespace),
  ]
  // Refuse to touch existing paths, including any links left by an unrelated service.
  for (const path of cleanup) {
    const info = await fs.lstat(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    assert.equal(info, undefined, 'Systemd test target already exists')
  }
  try {
    for (const name of ['index.mjs', 'version.json', 'monitor.mjs']) {
      await fs.copyFile(join(repository, 'server/dist', name), join(directory, name))
      await fs.chmod(join(directory, name), 0o644)
    }
    const version = JSON.parse(await fs.readFile(join(directory, 'version.json'))).id
    const privateDirectory = join(directory, 'config')
    await fs.mkdir(privateDirectory, { mode: 0o750 })
    await fs.chmod(privateDirectory, 0o750)
    const privateConfig = join(privateDirectory, 'monitor.json')
    await fs.writeFile(privateConfig, JSON.stringify({ healthUrl, unit: api }), { mode: 0o600 })
    const permissions = await fs.stat(privateDirectory)
    assert.equal(permissions.uid, 0)
    assert.equal(permissions.gid, 0)

    // Change only test coordinates; keep credential loading and the production sandbox intact.
    const template = (await fs.readFile(templatePath, 'utf8'))
      .replaceAll('/usr/bin/node', process.execPath)
      .replaceAll('StateDirectory=video-parser-monitor', 'StateDirectory=' + state)
      .replaceAll('RuntimeDirectory=video-parser-monitor', 'RuntimeDirectory=' + lock)
      .replaceAll('/var/lib/video-parser-monitor', '/var/lib/' + state)
      .replaceAll('/run/video-parser-monitor', '/run/' + lock)
      .replaceAll('--journal-namespace video-parser', '--journal-namespace ' + namespace)
      .replaceAll('LogNamespace=video-parser', 'LogNamespace=' + namespace)
      .replaceAll('SyslogIdentifier=video-parser-monitor', 'SyslogIdentifier=' + namespace)
      .replaceAll('/opt/video-parser/monitor/monitor.mjs', join(directory, 'monitor.mjs'))
      .replaceAll('/etc/video-parser/monitor.json', privateConfig)
    await fs.writeFile(join(directory, monitor), template, { mode: 0o644 })
    await fs.writeFile(
      join(directory, api),
      `[Unit]
Description=Isolated monitoring integration fixture
[Service]
DynamicUser=yes
ExecStart=${process.execPath} ${join(directory, 'index.mjs')}
Environment=HOST=127.0.0.1 PORT=${port}
StandardOutput=journal
StandardError=journal
LogNamespace=${namespace}
`,
      { mode: 0o644 },
    )
    await systemctl('link', '--runtime', join(directory, api), join(directory, monitor))
    await systemctl('daemon-reload')
    await systemctl('start', api)
    let healthy = false
    for (let i = 0; i < 80; i++) {
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
        assert.equal((await response.json()).data.version, version)
        healthy = true
        break
      } catch {
        await delay(50)
      }
    }
    assert.ok(healthy, 'Fixture API did not become healthy')
    await systemctl('start', monitor)
    const snapshot = JSON.parse(await fs.readFile(join('/var/lib', state, 'latest.json')))
    assert.equal(snapshot.report.health.ok, true)
    assert.equal(snapshot.report.health.version, version)
    assert.equal(snapshot.report.logs.ok, true)
    assert.ok(Object.hasOwn(snapshot.report.logs.versions, version))
    const after = await fs.stat(privateDirectory)
    assert.equal(after.mode & 0o777, 0o750)
    assert.equal(after.uid, permissions.uid)
    assert.equal(after.gid, permissions.gid)
    assert.equal((await fs.stat(privateConfig)).mode & 0o777, 0o600)
    console.log(
      JSON.stringify({
        systemdMonitoring: 'passed',
        privateConfig: '0750/0600',
        namespaceCollection: 'passed',
      }),
    )
  } finally {
    await systemctl('stop', monitor, api).catch(() => {})
    for (const unit of [
      `systemd-journald@${namespace}.socket`,
      `systemd-journald-varlink@${namespace}.socket`,
      `systemd-journald@${namespace}.service`,
    ])
      await systemctl('stop', unit).catch(() => {})
    for (const path of cleanup) await fs.rm(path, { recursive: true, force: true })
    await fs.rm(directory, { recursive: true, force: true })
    await systemctl('daemon-reload')
    await systemctl('reset-failed', monitor, api).catch(() => {})
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkMonitoringSystemd().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
