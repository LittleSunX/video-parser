import { expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLogSummary, summarizeStream } from '../scripts/summarize-diagnostics.mjs'

const id = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const event = (index, type, fields = {}) =>
  JSON.stringify({ requestId: id(index), event: type, version: 'release-a', ...fields })

test('interleaved stream headers, final outcomes and duplicate attempts are correlated once', () => {
  const summary = createLogSummary()
  const lines = [
    event(1, 'request_response', { operation: 'parse', status: 200, durationMs: 1 }),
    event(2, 'parse_first_usable', { sinceRequestMs: 30 }),
    event(1, 'parse_first_usable', { sinceRequestMs: 10 }),
    event(1, 'upstream_attempt', {
      strategy: 'web-detail',
      endpoint: 'web-detail',
      attempt: 1,
      result: 'success',
      durationMs: 8,
    }),
    event(1, 'upstream_attempt', {
      strategy: 'web-detail',
      endpoint: 'web-detail',
      attempt: 1,
      result: 'success',
      durationMs: 8,
    }),
    event(2, 'upstream_attempt', {
      strategy: 'mobile-feed',
      endpoint: 'feed-amemv-6383',
      attempt: 1,
      result: 'http_error',
      status: 429,
      durationMs: 12,
    }),
    event(1, 'parse_selection', { outcome: 'success', reason: 'complete', sinceRequestMs: 900 }),
    event(1, 'parse_stream_complete', { outcome: 'success', sinceRequestMs: 1000 }),
    event(2, 'parse_selection', { outcome: 'success', reason: 'exhausted', sinceRequestMs: 500 }),
    event(3, 'parse_selection', { outcome: 'cancelled', reason: 'cancelled', sinceRequestMs: 20 }),
    event(4, 'request_error', { code: 'PARSE_TIMEOUT' }),
    event(4, 'request_response', { operation: 'parse', status: 504 }),
    event(5, 'request_response', { operation: 'download', status: 200 }),
    event(6, 'request_response', { operation: 'parse', status: 200 }),
    event(7, 'request_response', { operation: 'parse', status: 204 }),
  ]
  lines.forEach(summary.add)
  const report = summary.finish()
  expect(report.parse).toEqual({
    observed: 5,
    complete: 1,
    unverified: 1,
    failed: 1,
    cancelled: 1,
    unfinished: 1,
    serverErrors: 1,
    successRate: 2 / 3,
    firstUsableMs: { samples: 2, p50: 10, p95: 30 },
    finalMs: { samples: 3, p50: 500, p95: 1000 },
  })
  expect(report.duplicateEvents).toBe(1)
  expect(report.upstream.attempts).toBe(2)
  expect(report.upstream.attemptsPerObservedParse).toBe(0.4)
  expect(report.upstream.strategies['mobile-feed'].rateLimited).toBe(1)
  expect(report.responseStatuses.download).toEqual({ 200: 1 })
  expect(report.responseStatuses.parse[204]).toBe(1)
})

test('cancel after selection overrides a tentative success and never counts as a failure', () => {
  const summary = createLogSummary()
  summary.add(
    event(1, 'parse_selection', { outcome: 'success', reason: 'complete', sinceRequestMs: 40 }),
  )
  summary.add(event(1, 'parse_stream_complete', { outcome: 'cancelled', sinceRequestMs: 50 }))
  expect(summary.finish().parse).toMatchObject({
    complete: 0,
    failed: 0,
    cancelled: 1,
    successRate: null,
  })
})

test('unknown fields, unrelated logs and request identities never leak into aggregates', async () => {
  const lines = [
    'PRIVATE_SHARE_TEXT',
    event(1, 'parse_selection', {
      outcome: 'success',
      reason: 'complete',
      sinceRequestMs: -1,
      url: 'https://private?token=secret',
      title: 'PRIVATE_TITLE',
    }),
    event(2, 'parse_selection', { version: 'different', outcome: 'error' }),
  ]
  const report = await summarizeStream(Readable.from([lines.join('\n')]), { version: 'release-a' })
  expect(report.parse).toMatchObject({
    observed: 1,
    complete: 1,
    finalMs: { samples: 0, p50: null, p95: null },
  })
  expect(report.ignoredLines).toBe(2)
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|private|secret|00000000|release-a/)
})

test('streaming handles split UTF-8 and enforces line and request bounds', async () => {
  const text = Buffer.from(
    event(1, 'request_response', { operation: 'parse', status: 200, title: '中文' }) + '\n',
  )
  const report = await summarizeStream(Readable.from([...text].map((byte) => Buffer.from([byte]))))
  expect(report.parse.unfinished).toBe(1)
  await expect(summarizeStream(Readable.from(['x'.repeat(64 * 1024 + 1)]))).rejects.toThrow(
    '64 KiB',
  )
  const summary = createLogSummary({ maxRequests: 1 })
  summary.add(event(1, 'request_response'))
  expect(() => summary.add(event(2, 'request_response'))).toThrow('Too many requests')
})

test('CLI reads stdin and reports file failures without echoing private paths or input', () => {
  const script = fileURLToPath(new URL('../scripts/summarize-diagnostics.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script, '-'], {
    input: event(1, 'parse_selection', {
      outcome: 'success',
      reason: 'complete',
      sinceRequestMs: 10,
    }),
    encoding: 'utf8',
  })
  expect(run.status, run.stderr).toBe(0)
  expect(JSON.parse(run.stdout).parse.complete).toBe(1)
  const failed = spawnSync(process.execPath, [script, 'PRIVATE_MISSING_LOG'], { encoding: 'utf8' })
  expect(failed.status).toBe(1)
  expect(failed.stderr).not.toContain('PRIVATE_MISSING_LOG')
})
