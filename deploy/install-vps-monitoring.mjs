import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// Explicit package allowlist, shared by the builder and the remote installer.
export const monitoringAssets = [
  'monitor.example.json',
  'video-parser-monitor.service',
  'video-parser-monitor.timer',
  'video-parser-journal.conf',
  'journald-video-parser.conf',
]
const timer = 'video-parser-monitor.timer'
const monitor = 'video-parser-monitor.service'
const journal = 'systemd-journald@video-parser.service'
const execute = promisify(execFile)

async function existing(path) {
  try {
    const info = await fs.lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)
      throw new Error('Unsafe monitoring installation file')
    return { body: await fs.readFile(path), mode: info.mode & 0o777, uid: info.uid, gid: info.gid }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function safeDirectory(path, create = false) {
  const parent = dirname(path)
  if (parent !== path) await safeDirectory(parent, create)
  try {
    const info = await fs.lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe monitoring directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (create) await fs.mkdir(path, { mode: 0o755 })
  }
}

async function replaceFile(path, value) {
  await safeDirectory(dirname(path), true)
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temporary, value.body, { flag: 'wx', mode: value.mode })
    await fs.chmod(temporary, value.mode)
    if (process.platform !== 'win32') await fs.chown(temporary, value.uid, value.gid)
    await fs.rename(temporary, path)
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Prepare without changing the server. Old archives keep their existing monitoring installation. */
export async function prepareMonitoring(
  entries,
  {
    root = '/opt/video-parser',
    systemRoot = '/',
    owner = { uid: 0, gid: 0 },
    run = (file, args) => execute(file, args, { timeout: 60_000, maxBuffer: 64 * 1024 }),
  } = {},
) {
  const names = monitoringAssets.map((name) => 'operations/' + name)
  if (!names.some((name) => entries.has(name))) return undefined
  for (const name of [...names, 'server/monitor.mjs']) {
    const entry = entries.get(name)
    if (!entry || entry.directory || !entry.body.length || entry.body.length > 4 * 1024 * 1024)
      throw new Error('Incomplete monitoring package')
  }
  const command = (args) => run('/usr/bin/systemctl', args)
  const version = await command(['--version'])
  if (Number(/^systemd (\d+)/.exec(version.stdout)?.[1] ?? 0) < 247)
    throw new Error('Monitoring requires systemd 247 or newer (LoadCredential)')
  const group = await run('/usr/bin/getent', ['group', 'systemd-journal'])
  const groupFields = group.stdout.trim().split(':')
  const gid = Number(groupFields[2])
  if (
    groupFields[0] !== 'systemd-journal' ||
    !/^\d+$/.test(groupFields[2] ?? '') ||
    !Number.isSafeInteger(gid)
  )
    throw new Error('Journal group unavailable')
  const unitState = (unit, property) => command(['show', unit, '--property=' + property, '--value'])
  const enabled = (await unitState(timer, 'UnitFileState')).stdout.trim()
  const active = (await unitState(timer, 'ActiveState')).stdout.trim() === 'active'
  if (enabled === 'masked' || enabled === 'masked-runtime')
    throw new Error('Monitoring timer is masked')
  const journalActive = (await unitState(journal, 'ActiveState')).stdout.trim() === 'active'
  const stopMonitor = async () => {
    for (const unit of [timer, monitor]) {
      if ((await unitState(unit, 'LoadState')).stdout.trim() === 'loaded')
        await command(['stop', unit])
    }
  }
  const etc = join(resolve(systemRoot), 'etc')
  const specs = [
    ['server/monitor.mjs', join(root, 'monitor/monitor.mjs')],
    ['operations/video-parser-monitor.service', join(etc, 'systemd/system', monitor)],
    ['operations/video-parser-monitor.timer', join(etc, 'systemd/system', timer)],
    [
      'operations/video-parser-journal.conf',
      join(etc, 'systemd/system/video-parser.service.d/60-video-parser-journal.conf'),
    ],
    [
      'operations/journald-video-parser.conf',
      join(etc, 'systemd/journald@video-parser.conf'),
      true,
    ],
    ['operations/monitor.example.json', join(etc, 'video-parser/monitor.json'), true, 0o600],
  ]
  const changes = []
  for (const [name, path, preserve, mode = 0o644] of specs) {
    await safeDirectory(dirname(path))
    const before = await existing(path)
    if (preserve && before) continue
    const after = {
      body: entries.get(name).body,
      mode,
      uid: owner.uid,
      gid: owner.gid,
    }
    if (
      before &&
      before.body.equals(after.body) &&
      before.mode === mode &&
      before.uid === after.uid &&
      before.gid === after.gid
    )
      continue
    changes.push({ path, before, after })
  }
  const written = []
  let started = false
  let enableAttempted = false
  return {
    async install() {
      started = true
      await stopMonitor()
      for (const change of changes) {
        await replaceFile(change.path, change.after)
        written.push(change)
      }
      await run('/usr/bin/systemd-analyze', [
        'verify',
        join(etc, 'systemd/system', monitor),
        join(etc, 'systemd/system', timer),
      ])
      await command(['daemon-reload'])
      // Restart only this project's journal; the API is stopped by the release transaction.
      await command(['restart', journal])
    },
    async verify(version) {
      const since = Date.now()
      await command(['start', monitor])
      // A zero exit alone is insufficient: the sampler can successfully report a broken log source.
      const snapshot = await existing(
        join(resolve(systemRoot), 'var/lib/video-parser-monitor/latest.json'),
      )
      const report = snapshot && JSON.parse(snapshot.body.toString()).report
      const sampledAt = Date.parse(report?.timestamp)
      if (
        !report ||
        !Number.isFinite(sampledAt) ||
        sampledAt < since ||
        sampledAt > Date.now() ||
        !report.health?.ok ||
        report.health.version !== version ||
        !report.logs?.ok ||
        !Object.hasOwn(report.logs.versions ?? {}, version)
      )
        throw new Error('Monitoring first sample failed verification')
      enableAttempted = true
      await command(['enable', '--now', timer])
      await command(['is-active', '--quiet', timer])
      await command(['is-enabled', '--quiet', timer])
    },
    async rollback() {
      if (!started) return
      await stopMonitor()
      if (enableAttempted && enabled !== 'enabled') await command(['disable', timer])
      for (const change of [...written].reverse()) {
        if (change.before) await replaceFile(change.path, change.before)
        else await fs.unlink(change.path)
      }
      await command(['daemon-reload'])
      await command([journalActive ? 'restart' : 'stop', journal])
      if (enabled === 'enabled') await command(['enable', timer])
      if (enabled === 'enabled-runtime') await command(['enable', '--runtime', timer])
      if (active) await command(['start', timer])
    },
  }
}
