import { afterEach, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { monitoringAssets, prepareMonitoring } from '../deploy/install-vps-monitoring.mjs'

const directories = []
const version = '11111111-2222-4333-8444-555555555555'
afterEach(async () => {
  for (const path of directories.splice(0)) {
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('video-parser-install-'))
      throw new Error('Unsafe cleanup')
    await fs.rm(path, { recursive: true, force: true })
  }
})

async function fixture({ badSample = false, failInstall = false, legacy = false } = {}) {
  const systemRoot = resolve(await fs.mkdtemp(join(tmpdir(), 'video-parser-install-')))
  directories.push(systemRoot)
  const root = join(systemRoot, 'opt/video-parser')
  const etc = join(systemRoot, 'etc')
  const units = new Map()
  const timer = 'video-parser-monitor.timer'
  const monitor = 'video-parser-monitor.service'
  const journal = 'systemd-journald@video-parser.service'
  const entries = new Map()
  for (const name of monitoringAssets)
    entries.set('operations/' + name, {
      body: await fs.readFile(new URL('../deploy/' + name, import.meta.url)),
      directory: false,
    })
  entries.set('server/monitor.mjs', { body: Buffer.from('new monitor'), directory: false })
  await fs.mkdir(join(root, 'monitor'), { recursive: true })
  await fs.mkdir(join(etc, 'systemd/system'), { recursive: true })
  if (legacy) {
    for (const name of [timer, monitor]) {
      await fs.writeFile(join(etc, 'systemd/system', name), 'old ' + name)
      units.set(name, {
        LoadState: 'loaded',
        ActiveState: name === timer ? 'active' : 'inactive',
        UnitFileState: name === timer ? 'enabled' : 'static',
      })
    }
    await fs.writeFile(join(root, 'monitor/monitor.mjs'), 'old monitor')
  }
  const calls = []
  const run = vi.fn(async (file, args) => {
    calls.push([file, ...args])
    if (file.endsWith('getent'))
      return { stdout: `systemd-journal:x:${process.getgid?.() ?? 0}:\n` }
    if (file.endsWith('systemd-analyze')) {
      if (failInstall) throw new Error('Invalid unit')
      return { stdout: '' }
    }
    const [action, ...names] = args
    if (action === '--version') return { stdout: 'systemd 255\n' }
    if (action === 'show')
      return {
        stdout: (units.get(names[0])?.[names[1].replace('--property=', '')] ?? 'not-found') + '\n',
      }
    if (action === 'daemon-reload') {
      for (const name of [timer, monitor]) {
        const present = await fs.stat(join(etc, 'systemd/system', name)).then(
          () => true,
          () => false,
        )
        if (present)
          units.set(name, {
            UnitFileState: 'disabled',
            ActiveState: 'inactive',
            ...units.get(name),
            LoadState: 'loaded',
          })
        else units.delete(name)
      }
    }
    for (const name of names.filter((name) => !name.startsWith('--'))) {
      if (['stop', 'start', 'enable'].includes(action) && name !== journal && !units.has(name))
        throw new Error('Unknown unit')
      if (action === 'stop') units.set(name, { ...units.get(name), ActiveState: 'inactive' })
      if (action === 'disable') units.set(name, { ...units.get(name), UnitFileState: 'disabled' })
      if (action === 'enable')
        units.set(name, {
          ...units.get(name),
          UnitFileState: 'enabled',
          ...(names.includes('--now') ? { ActiveState: 'active' } : {}),
        })
      if (action === 'start' || action === 'restart')
        units.set(name, { ...units.get(name), ActiveState: 'active' })
    }
    if (action === 'start' && names[0] === monitor) {
      const folder = join(systemRoot, 'var/lib/video-parser-monitor')
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(
        join(folder, 'latest.json'),
        JSON.stringify({
          report: {
            timestamp: new Date().toISOString(),
            health: { ok: true, version },
            logs: { ok: !badSample, versions: { [version]: {} } },
          },
        }),
      )
    }
    return { stdout: '' }
  })
  const options = {
    root,
    systemRoot,
    run,
    owner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  }
  return { entries, options, root, etc, calls, units, timer, monitor, journal }
}

test('first deployment installs isolated monitoring, verifies a fresh sample and enables the timer', async () => {
  const f = await fixture()
  const operation = await prepareMonitoring(f.entries, f.options)
  expect(f.calls.some((call) => ['stop', 'start', 'restart'].includes(call[1]))).toBe(false)
  await operation.install()
  await operation.verify(version)
  expect(await fs.readFile(join(f.root, 'monitor/monitor.mjs'), 'utf8')).toBe('new monitor')
  const config = await fs.readFile(join(f.etc, 'video-parser/monitor.json'), 'utf8')
  expect(JSON.parse(config).healthUrl).toBe('http://127.0.0.1:8787/api/health')
  expect(await fs.readFile(join(f.etc, 'systemd/journald@video-parser.conf'), 'utf8')).toContain(
    'ForwardToSyslog=no',
  )
  expect(f.units.get(f.timer)).toMatchObject({ UnitFileState: 'enabled', ActiveState: 'active' })
  expect(
    f.calls.some(
      (call) =>
        call.includes('systemd-journald.service') ||
        call.includes('rsyslog.service') ||
        call.includes('nginx.service'),
    ),
  ).toBe(false)
  expect(f.calls.filter((call) => call[1] === 'restart').map((call) => call[2])).toEqual([
    f.journal,
  ])
})

test('repeated deployment preserves custom thresholds, retention settings and saved alert state', async () => {
  const f = await fixture()
  let operation = await prepareMonitoring(f.entries, f.options)
  await operation.install()
  await operation.verify(version)
  const configPath = join(f.etc, 'video-parser/monitor.json')
  const retentionPath = join(f.etc, 'systemd/journald@video-parser.conf')
  await fs.writeFile(configPath, '{"minSamples":37}')
  await fs.writeFile(retentionPath, '[Journal]\nSystemMaxUse=96M\n')
  const statePath = join(f.options.systemRoot, 'var/lib/video-parser-monitor/latest.json')
  const state = await fs.readFile(statePath)
  operation = await prepareMonitoring(f.entries, f.options)
  await operation.install()
  expect(await fs.readFile(configPath, 'utf8')).toBe('{"minSamples":37}')
  expect(await fs.readFile(retentionPath, 'utf8')).toBe('[Journal]\nSystemMaxUse=96M\n')
  expect(await fs.readFile(statePath)).toEqual(state)
})

test.each([false, true])(
  'failed sample restores the previous monitoring installation (legacy=%s)',
  async (legacy) => {
    const f = await fixture({ badSample: true, legacy })
    const operation = await prepareMonitoring(f.entries, f.options)
    await operation.install()
    await expect(operation.verify(version)).rejects.toThrow('sample')
    await operation.rollback()
    if (legacy) {
      expect(await fs.readFile(join(f.root, 'monitor/monitor.mjs'), 'utf8')).toBe('old monitor')
      expect(await fs.readFile(join(f.etc, 'systemd/system', f.monitor), 'utf8')).toBe(
        'old ' + f.monitor,
      )
      expect(f.units.get(f.timer)).toMatchObject({
        UnitFileState: 'enabled',
        ActiveState: 'active',
      })
    } else {
      await expect(fs.stat(join(f.root, 'monitor/monitor.mjs'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(fs.stat(join(f.etc, 'systemd/system', f.monitor))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
    await expect(
      fs.stat(join(f.etc, 'systemd/system/video-parser.service.d/60-video-parser-journal.conf')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

test('partly installed units are restored even before daemon reload', async () => {
  const f = await fixture({ failInstall: true, legacy: true })
  const operation = await prepareMonitoring(f.entries, f.options)
  await expect(operation.install()).rejects.toThrow('Invalid unit')
  await operation.rollback()
  expect(await fs.readFile(join(f.root, 'monitor/monitor.mjs'), 'utf8')).toBe('old monitor')
  expect(f.units.get(f.timer).ActiveState).toBe('active')
})

test('legacy archives do not uninstall monitoring, incomplete new archives and old systemd fail before writes', async () => {
  const f = await fixture()
  await expect(prepareMonitoring(new Map(), f.options)).resolves.toBeUndefined()
  const partial = new Map(f.entries)
  partial.delete('operations/video-parser-monitor.timer')
  await expect(prepareMonitoring(partial, f.options)).rejects.toThrow('Incomplete')
  const run = vi.fn(async () => ({ stdout: 'systemd 244\n' }))
  await expect(prepareMonitoring(f.entries, { ...f.options, run })).rejects.toThrow('245')
  expect(run).toHaveBeenCalledTimes(1)
})

test('symlinked installation directories are rejected without overwriting their targets', async () => {
  const f = await fixture()
  const outside = join(f.options.systemRoot, 'unrelated')
  await fs.mkdir(outside)
  await fs.symlink(
    outside,
    join(f.etc, 'video-parser'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await expect(prepareMonitoring(f.entries, f.options)).rejects.toThrow(
    'Unsafe monitoring directory',
  )
  expect(await fs.readdir(outside)).toEqual([])
})
