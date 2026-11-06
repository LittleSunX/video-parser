import { afterEach, expect, test, vi } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { monitorConfig, advanceAlerts, evaluateRules } from '../scripts/monitoring/policy.mjs'
import { observeLogs, probeHealth } from '../scripts/monitoring/observations.mjs'
import { journalArguments, runMonitor } from '../scripts/monitor-runtime.mjs'

test('installed monitoring reads its dedicated namespace and rejects namespace injection', () => {
  expect(journalArguments(monitorConfig(), Date.now(), 'video-parser')[0]).toBe(
    '--namespace=video-parser',
  )
  for (const name of ['*', '+video-parser', '--system', 'a/b', ''])
    expect(() => journalArguments(monitorConfig(), Date.now(), name)).toThrow()
})
import { createLogSummary } from '../scripts/summarize-diagnostics.mjs'
import { fetchMedia } from '../backend/src/services/media-download'

const now = Date.parse('2026-11-06T08:00:00.000Z')
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const record = (n, event, fields = {}) =>
  JSON.stringify({
    event,
    requestId: id(n),
    version: 'release-a',
    runtime: 'node',
    timestamp: new Date(now - 1000).toISOString(),
    ...fields,
  })
const healthy = { ok: true, version: 'release-a', runtime: 'node' }
const dirs = []
const servers = []
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'video-parser-monitor-test-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

function summary(lines = []) {
  const result = createLogSummary()
  lines.forEach(result.add)
  return result.finish()
}
function observation(at, health = healthy, metrics = summary()) {
  return { at, health, logs: { ok: true, versions: { 'release-a': metrics } } }
}

test('alerts require consecutive evidence, persist suppression and record one recovery', () => {
  const config = monitorConfig({ reminderSeconds: 120 })
  const down = { ok: false }
  let result = advanceAlerts(undefined, observation(now, down), config)
  expect(result.alerts).toEqual([])
  result = advanceAlerts(result.state, observation(now + 60000, down), config)
  expect(result.alerts).toMatchObject([{ rule: 'service_unavailable', transition: 'firing' }])
  result = advanceAlerts(
    JSON.parse(JSON.stringify(result.state)),
    observation(now + 120000, down),
    config,
  )
  expect(result.alerts).toEqual([])
  result = advanceAlerts(result.state, observation(now + 180000, down), config)
  expect(result.alerts).toMatchObject([{ transition: 'reminder' }])
  result = advanceAlerts(result.state, observation(now + 240000), config)
  expect(result.alerts).toEqual([])
  result = advanceAlerts(result.state, observation(now + 300000), config)
  expect(result.alerts).toMatchObject([{ transition: 'recovered' }])
  expect(advanceAlerts(result.state, observation(now + 360000), config).alerts).toEqual([])
  expect(() => advanceAlerts(result.state, observation(now), config)).toThrow('did not advance')
})

test('no traffic and missing samples do not falsely recover a firing metric', () => {
  const config = monitorConfig({ minSamples: 1, consecutiveFailures: 1, consecutiveRecoveries: 1 })
  const bad = summary([
    record(1, 'request_error', { code: 'PARSE_TIMEOUT' }),
    record(1, 'request_response', { operation: 'parse', status: 504 }),
  ])
  let result = advanceAlerts(undefined, observation(now, healthy, bad), config)
  expect(result.state.rules.parse_server_errors.active).toBe(true)
  result = advanceAlerts(result.state, observation(now + 60000), config)
  expect(result.state.rules.parse_server_errors.active).toBe(true)
  expect(result.alerts).toEqual([])
  const good = summary([record(2, 'parse_selection', { outcome: 'success', reason: 'complete' })])
  result = advanceAlerts(result.state, observation(now + 120000, healthy, good), config)
  expect(result.alerts).toMatchObject([{ rule: 'parse_server_errors', transition: 'recovered' }])
})

test('invalid input is not a server failure and HTTP 200 is not a completed transfer', () => {
  const metrics = summary([
    record(1, 'request_error', { code: 'INVALID_INPUT' }),
    record(1, 'request_response', { operation: 'parse', status: 400 }),
    record(2, 'request_response', { operation: 'download', status: 200 }),
    record(3, 'download_transfer', { outcome: 'error', bytes: 3 }),
    record(4, 'download_transfer', { outcome: 'cancelled', bytes: 2 }),
    record(5, 'download_transfer', { outcome: 'success', bytes: 10 }),
    record(5, 'download_transfer', { outcome: 'success', bytes: 10 }),
  ])
  expect(metrics.parse.serverErrors).toBe(0)
  expect(metrics.download).toEqual({
    complete: 1,
    failed: 1,
    cancelled: 1,
    unfinished: 1,
    bytes: 15,
  })
  const rules = evaluateRules(observation(now, healthy, metrics), monitorConfig({ minSamples: 1 }))
  expect(rules.proxy_transfer_errors).toMatchObject({ bad: true, value: 0.5, samples: 2 })
})

test('upstream rejection, timeout and latency rules use current version and sufficient samples', () => {
  const metrics = summary([
    record(1, 'upstream_attempt', {
      strategy: 'web-detail',
      endpoint: 'web-detail',
      attempt: 1,
      status: 403,
      result: 'http_error',
    }),
    record(1, 'upstream_attempt', {
      strategy: 'mobile-feed',
      endpoint: 'feed-amemv-6383',
      attempt: 1,
      result: 'timeout',
    }),
    record(1, 'parse_selection', { outcome: 'error', sinceRequestMs: 20000 }),
    record(1, 'request_response', { operation: 'parse', status: 504 }),
  ])
  const config = monitorConfig({ minSamples: 1 })
  const rules = evaluateRules(observation(now, healthy, metrics), config)
  expect(rules.upstream_rejected.bad).toBe(true)
  expect(rules.upstream_timeouts.bad).toBe(true)
  expect(rules.parse_latency.bad).toBe(true)
  expect(
    evaluateRules(observation(now, { ...healthy, version: 'new-release' }, metrics), config)
      .parse_latency.bad,
  ).toBeNull()
})

test('an unknown version cannot select inherited properties as metric data', () => {
  const result = evaluateRules(
    observation(now, { ...healthy, version: 'constructor' }),
    monitorConfig(),
  )
  expect(result.diagnostics_unavailable.bad).toBe(true)
  expect(result.parse_latency.bad).toBeNull()
})

test('journal and NDJSON records are windowed, grouped by version and scrubbed', async () => {
  const current = record(1, 'parse_selection', {
    outcome: 'success',
    reason: 'complete',
    sinceRequestMs: 10,
    private: 'SECRET_VALUE',
  })
  const journal = JSON.stringify({
    __REALTIME_TIMESTAMP: String((now - 2000) * 1000),
    MESSAGE: record(2, 'parse_selection', {
      outcome: 'success',
      reason: 'complete',
      version: 'release-b',
      timestamp: undefined,
    }),
  })
  const old = record(3, 'parse_selection', { timestamp: new Date(now - 700000).toISOString() })
  const future = record(4, 'parse_selection', { timestamp: new Date(now + 1000).toISOString() })
  const report = await observeLogs(
    Readable.from([current + '\n' + journal + '\n' + old + '\n' + future]),
    { now, windowSeconds: 600 },
  )
  expect(report.ok).toBe(true)
  expect(report.accepted).toBe(2)
  expect(report.versions['release-a'].parse.complete).toBe(1)
  expect(report.versions['release-b'].parse.complete).toBe(1)
  expect(JSON.stringify(report)).not.toMatch(/SECRET_VALUE|00000000/)
  await expect(
    observeLogs(Readable.from(['x'.repeat(65537)]), { now, windowSeconds: 600 }),
  ).rejects.toThrow('limit')
  await expect(
    observeLogs(Readable.from([current]), { now, windowSeconds: 600, maxBytes: 10 }),
  ).rejects.toThrow('limit')
  expect((await observeLogs(Readable.from(['unrecognized']), { now, windowSeconds: 600 })).ok).toBe(
    false,
  )
})

test.each([
  { windowSeconds: 0 },
  { minSamples: 0 },
  { failureRate: 0 },
  { consecutiveFailures: 1.5 },
  { unit: 'video-parser.service; command' },
  { healthUrl: 'https://user:password@example.com/api/health' },
  { healthUrl: 'https://example.com/api/health?token=secret' },
  { webhook: 'not supported' },
])('invalid configuration is rejected: %j', (input) => {
  expect(() => monitorConfig(input)).toThrow()
})

test('journal uses an argument array with explicit unit and a bounded time window', () => {
  expect(journalArguments(monitorConfig(), now)).toEqual([
    '--unit',
    'video-parser.service',
    '--since',
    '@1793951400',
    '--until',
    '@1793952000',
    '--output=json',
    '--no-pager',
    '--quiet',
  ])
})

test('an empty or unrecognized journal is not evidence that diagnostic collection is healthy', async () => {
  const empty = await observeLogs(Readable.from([]), { now, windowSeconds: 600 })
  expect(empty).toMatchObject({ ok: false, reason: 'no_usable_records' })
  const unrelated = await observeLogs(Readable.from([record(1, 'unknown_event')]), {
    now,
    windowSeconds: 600,
  })
  expect(unrelated.ok).toBe(false)
  const input = { at: now, health: healthy, logs: empty }
  expect(evaluateRules(input, monitorConfig()).diagnostics_unavailable.bad).toBe(true)
  input.health = { ok: false }
  expect(evaluateRules(input, monitorConfig()).diagnostics_unavailable.bad).toBeNull()
})

test('request limits apply across versions, and an error response cannot produce a rate above one', async () => {
  const lines = [
    record(1, 'request_response', { operation: 'parse', status: 503 }),
    record(1, 'request_response', { operation: 'parse', status: 503, version: 'release-b' }),
  ]
  await expect(
    observeLogs(Readable.from([lines.join('\n')]), { now, windowSeconds: 600, maxRequests: 1 }),
  ).rejects.toThrow('Too many requests')
  const metrics = summary([lines[0]])
  expect(metrics.parse).toMatchObject({ failed: 1, serverErrors: 1, unfinished: 0 })
  expect(
    evaluateRules(observation(now, healthy, metrics), monitorConfig({ minSamples: 1 }))
      .parse_server_errors.value,
  ).toBe(1)
})

test('real HTTP health checks reject redirects, invalid bodies and stalled connections', async () => {
  let mode = 'healthy'
  const server = createServer((_request, response) => {
    if (mode === 'stall') return
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/api/health' })
      response.end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (mode === 'large') {
      response.end('x'.repeat(20000))
      return
    }
    response.end(
      JSON.stringify(
        mode === 'invalid'
          ? { success: true }
          : {
              success: true,
              data: {
                service: 'video-parser-api',
                status: 'ok',
                runtime: 'node',
                version: 'release-a',
                versionTag: 'a'.repeat(40),
              },
            },
      ),
    )
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/api/health`
  expect(await probeHealth(url)).toMatchObject({ ok: true, version: 'release-a' })
  for (mode of ['redirect', 'invalid', 'large', 'stall'])
    expect((await probeHealth(url, { timeoutMs: 80 })).ok).toBe(false)
})

test('persistent snapshots suppress repeats, preserve recovery and refuse corrupt state', async () => {
  const directory = await temporary()
  const logs = { ok: true, versions: { 'release-a': summary() } }
  const options = {
    config: { consecutiveFailures: 1, consecutiveRecoveries: 1 },
    stateDirectory: directory,
    journal: async () => logs,
    healthProbe: async () => ({ ok: false }),
  }
  expect((await runMonitor({ ...options, now })).alerts).toMatchObject([{ transition: 'firing' }])
  expect((await runMonitor({ ...options, now: now + 60000 })).alerts).toEqual([])
  expect(
    (await runMonitor({ ...options, now: now + 120000, healthProbe: async () => healthy })).alerts,
  ).toMatchObject([{ transition: 'recovered' }])
  expect(JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8')).report.health.ok).toBe(
    true,
  )
  await writeFile(join(directory, 'latest.json'), 'corrupt')
  await expect(runMonitor({ ...options, now: now + 180000 })).rejects.toThrow()
})

test('overlapping monitoring passes cannot both change the alert state', async () => {
  const directory = await temporary()
  let release
  let entered
  const gate = new Promise((resolve) => {
    entered = resolve
  })
  const first = runMonitor({
    config: {},
    stateDirectory: directory,
    now,
    journal: async () => ({ ok: true, versions: {} }),
    healthProbe: () =>
      new Promise((resolve) => {
        release = () => resolve(healthy)
        entered()
      }),
  })
  await gate
  await expect(
    runMonitor({ config: {}, stateDirectory: directory, now: now + 1 }),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  release()
  await first
})

test('monitor CLI errors do not disclose a private config path or its contents', () => {
  const result = spawnSync(
    process.execPath,
    [
      'server/monitor-entry.mjs',
      '--config',
      'PRIVATE_MISSING.json',
      '--state-dir',
      'PRIVATE_STATE',
    ],
    { encoding: 'utf8' },
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('MONITOR_RUN_FAILED')
  expect(result.stderr + result.stdout).not.toContain('PRIVATE')
})

test.each(['complete', 'short', 'cancel'])(
  'proxy diagnostics record exactly one %s terminal and no media URL',
  async (mode) => {
    const emit = vi.fn()
    const body =
      mode === 'cancel'
        ? new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array([1]))
            },
          })
        : new Uint8Array(mode === 'short' ? [1] : [1, 2])
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 206,
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1/2' },
          }),
      ),
    )
    const response = await fetchMedia(
      new URL('https://v.douyinvod.com/fixture.mp4'),
      null,
      new AbortController().signal,
      { emit },
    )
    if (mode === 'short')
      await expect(response.arrayBuffer()).rejects.toHaveProperty('code', 'DOWNLOAD_NETWORK_ERROR')
    else if (mode === 'cancel') await response.body.cancel()
    else expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
    expect(emit).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith(
      'download_transfer',
      expect.objectContaining({
        outcome: mode === 'short' ? 'error' : mode === 'cancel' ? 'cancelled' : 'success',
        rangeRequest: false,
      }),
    )
    expect(JSON.stringify(emit.mock.calls)).not.toContain('douyinvod')
  },
)
