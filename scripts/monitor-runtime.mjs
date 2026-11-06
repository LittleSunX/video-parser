import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { advanceAlerts, monitorConfig, validAlertState } from './monitoring/policy.mjs'
import { observeLogs, probeHealth } from './monitoring/observations.mjs'

async function readJson(path, maxBytes) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid monitor file')
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size > maxBytes) throw new Error('Monitor file exceeds limit')
    return JSON.parse(buffer.subarray(0, size).toString('utf8'))
  } finally {
    await file.close()
  }
}

async function atomicJson(path, data) {
  const temporary = path + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify(data) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export function journalArguments(config, now, namespace) {
  if (namespace !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(namespace))
    throw new Error('Invalid journal namespace')
  return [
    ...(namespace ? ['--namespace=' + namespace] : []),
    '--unit',
    config.unit,
    '--since',
    '@' + Math.floor(now / 1000 - config.windowSeconds),
    '--until',
    '@' + Math.ceil(now / 1000),
    '--output=json',
    '--no-pager',
    '--quiet',
  ]
}

export async function collectJournal(config, now, namespace) {
  const child = spawn('journalctl', journalArguments(config, now, namespace), {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const exit = new Promise((resolve) => {
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
  try {
    const logs = await observeLogs(child.stdout, { now, windowSeconds: config.windowSeconds })
    if (!(await exit)) throw new Error('Journal unavailable')
    return logs
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}

/** One bounded sampling pass; the independent timer owns scheduling and survives API restarts. */
export async function runMonitor({
  config,
  stateDirectory,
  lockDirectory = stateDirectory,
  logFile,
  journalNamespace,
  now = Date.now(),
  healthProbe = probeHealth,
  journal = collectJournal,
}) {
  config = monitorConfig(config)
  journalArguments(config, now, journalNamespace)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 })
  const lockPath = join(lockDirectory, 'monitor.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([config, logFile ?? '', journalNamespace ?? '']))
    .digest('hex')
  const snapshotPath = join(stateDirectory, 'latest.json')
  try {
    let previous
    try {
      const snapshot = await readJson(snapshotPath, 8 * 1024 * 1024)
      if (snapshot.schema !== 1 || !validAlertState(snapshot.state))
        throw new Error('Invalid saved monitor state')
      if (snapshot.fingerprint === fingerprint) previous = snapshot.state
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const [health, logs] = await Promise.all([
      healthProbe(config.healthUrl),
      (async () => {
        try {
          if (!logFile) return await journal(config, now, journalNamespace)
          const stream = createReadStream(logFile)
          try {
            return await observeLogs(stream, { now, windowSeconds: config.windowSeconds })
          } finally {
            stream.destroy()
          }
        } catch {
          return { ok: false, reason: 'collection_failed', versions: {} }
        }
      })(),
    ])
    const observation = { at: now, health, logs }
    const { state, alerts } = advanceAlerts(previous, observation, config)
    const report = {
      event: 'monitor_observation',
      timestamp: new Date(now).toISOString(),
      windowSeconds: config.windowSeconds,
      health,
      logs,
      activeAlerts: Object.entries(state.rules)
        .filter(([, value]) => value.active)
        .map(([name]) => name),
    }
    // Keep the latest report and alert state in a single atomic snapshot across restarts.
    await atomicJson(snapshotPath, { schema: 1, fingerprint, state, report, alerts })
    return { report, alerts }
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

export async function monitorMain(args = process.argv.slice(2)) {
  if (args.length === 0 || args.includes('--help')) {
    console.log(
      'Usage: monitor --config <private.json> --state-dir <directory> [--lock-dir <directory>] [--log-file <timestamped.ndjson>] [--journal-namespace <name>]',
    )
    return
  }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (
      !['--config', '--state-dir', '--lock-dir', '--log-file', '--journal-namespace'].includes(
        key,
      ) ||
      options[key] ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('Invalid monitor arguments')
    options[key] = args[i + 1]
  }
  if (!options['--config'] || !options['--state-dir'])
    throw new Error('Monitor config and state directory required')
  const { report, alerts } = await runMonitor({
    config: await readJson(resolve(options['--config']), 16 * 1024),
    stateDirectory: resolve(options['--state-dir']),
    ...(options['--lock-dir'] ? { lockDirectory: resolve(options['--lock-dir']) } : {}),
    ...(options['--log-file'] ? { logFile: resolve(options['--log-file']) } : {}),
    journalNamespace: options['--journal-namespace'],
  })
  console.log(JSON.stringify(report))
  for (const event of alerts) console.log(JSON.stringify(event))
}
