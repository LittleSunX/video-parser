import { afterEach, expect, test, vi } from 'vitest'
import worker from '../worker/src/index'
import { createDiagnostics, withDiagnostics } from '../worker/src/utils/diagnostics'
import { runParseStrategies } from '../worker/src/parsers/douyin/strategies'
import { parseVideo } from '../frontend/src/api/video'
import { errorResponse } from '../worker/src/utils/error-response'

const allowed = { limit: async () => ({ success: true }) }
const env = {
  PARSE_RATE_LIMITER: allowed,
  DOWNLOAD_RATE_LIMITER: allowed,
  CF_VERSION_METADATA: { id: 'deployment-123', tag: 'release', timestamp: '2026-09-30' },
}
const api = 'https://api.example.com'
const source = 'https://www.douyin.com/video/123'
const video = {
  platform: 'douyin',
  mediaType: 'video',
  videoId: '123',
  sourceUrl: source,
  title: 'PRIVATE_TITLE',
  videoUrl: 'https://v.douyinvod.com/a?signature=PRIVATE_SIGNATURE',
}
const request = () =>
  new Request(api + '/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'untrusted' },
    body: JSON.stringify({ url: source }),
  })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('health exposes deployment identity and responses preserve CORS headers', async () => {
  const response = await worker.fetch(new Request(api + '/api/health'), env)
  expect((await response.json()).data.version).toBe('deployment-123')
  expect(response.headers.get('X-Worker-Version')).toBe('deployment-123')
  expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/)
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After')
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-ID')
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Server-Timing')).toMatch(/^worker;dur=\d+$/)
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Server-Timing')
  const local = await worker.fetch(new Request(api + '/api/health'), {})
  expect((await local.json()).data.version).toBe('unknown')
})

test('timing headers use fixed metric names and do not consume response streams', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const trace = createDiagnostics()
  trace.emit('resolve_complete', { durationMs: 100 })
  trace.emit('strategy_complete', { strategy: 'web-detail', durationMs: 200 })
  trace.emit('strategy_complete', { strategy: 'PRIVATE_NAME', durationMs: 300 })
  trace.emit('request_response', { durationMs: 310 })
  let reads = 0
  const stream = new ReadableStream({
    pull(controller) {
      reads++
      controller.enqueue(new Uint8Array([1, 2]))
      controller.close()
    },
  })
  const response = withDiagnostics(new Response(stream), trace)
  expect(response.body).toBe(stream)
  expect(reads).toBe(0)
  expect(response.headers.get('Server-Timing')).toBe(
    'resolve;dur=100, primary;dur=200, worker;dur=310',
  )
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2])
})

test('invalid durations and unknown events do not enter timing headers', () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const trace = createDiagnostics()
  trace.emit('resolve_complete', { durationMs: Number.NaN })
  trace.emit('request_response', { durationMs: -1 })
  trace.emit('PRIVATE_EVENT', { durationMs: 100 })
  expect(withDiagnostics(new Response(null), trace).headers.has('Server-Timing')).toBe(false)
})

test('concurrent parse requests have independent traces without leaking media data', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        aweme_detail: {
          aweme_id: '123',
          desc: video.title,
          video: { play_addr: { url_list: [video.videoUrl] } },
        },
      }),
    ),
  )
  const responses = await Promise.all([worker.fetch(request(), env), worker.fetch(request(), env)])
  const ids = responses.map((response) => response.headers.get('X-Request-ID'))
  expect(new Set(ids).size).toBe(2)
  const records = logs.mock.calls
    .filter(([message]) => typeof message === 'string' && message.startsWith('{'))
    .map(([message]) => JSON.parse(message))
  for (const id of ids) {
    const events = records.filter((record) => record.requestId === id)
    expect(events.find((record) => record.event === 'strategy_complete')).toMatchObject({
      strategy: 'web-detail',
      outcome: 'success',
      videos: 1,
    })
    expect(events.find((record) => record.event === 'parse_result')).toMatchObject({ videos: 1 })
    expect(events.find((record) => record.event === 'request_response')).toMatchObject({
      status: 200,
      operation: 'parse',
      version: 'deployment-123',
    })
    expect(events.every((record) => !('durationMs' in record) || record.durationMs >= 0)).toBe(true)
  }
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com|untrusted/)
})

test('invalid and rate-limited requests retain correlation and retry headers', async () => {
  const response = await worker.fetch(request(), {
    ...env,
    PARSE_RATE_LIMITER: { limit: async () => ({ success: false }) },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
  expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/)
  const missing = await worker.fetch(new Request(api + '/missing'), env)
  expect(missing.status).toBe(404)
  expect(missing.headers.get('X-Request-ID')).toBeTruthy()
  const preflight = await worker.fetch(new Request(api, { method: 'OPTIONS' }), env)
  expect(preflight.status).toBe(204)
  expect(preflight.body).toBeNull()
})

test('download diagnostics preserve partial responses without consuming their streams', async () => {
  let cancelled = false
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]))
            },
            cancel() {
              cancelled = true
            },
          }),
          {
            status: 206,
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1/10' },
          },
        ),
    ),
  )
  const response = await worker.fetch(
    new Request(api + '/api/download?url=' + encodeURIComponent(video.videoUrl), {
      headers: { Range: 'bytes=0-1' },
    }),
    env,
  )
  expect(response.status).toBe(206)
  expect(response.headers.get('Content-Range')).toBe('bytes 0-1/10')
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range')
  expect(response.headers.get('X-Request-ID')).toBeTruthy()
  const reader = response.body.getReader()
  expect([...(await reader.read()).value]).toEqual([1, 2])
  await reader.cancel()
  expect(cancelled).toBe(true)
})

test('partial image fallback logs exhaustion instead of claiming complete selection', async () => {
  const emit = vi.fn()
  const partial = { mediaType: 'image', images: [{ url: '', livePhotoUrl: video.videoUrl }] }
  const result = await runParseStrategies(
    [
      { name: 'partial', run: async () => ({ video: partial, imagesComplete: false }) },
      {
        name: 'failed',
        run: async () => {
          throw new Error('PRIVATE_SIGNATURE')
        },
      },
    ],
    undefined,
    { requestId: 'test', version: 'test', emit },
  )
  expect(result).toEqual({ ...partial, parseStatus: 'unverified', parseReason: 'exhausted' })
  expect(emit).toHaveBeenCalledWith(
    'parse_selection',
    expect.objectContaining({
      reason: 'exhausted',
      images: 0,
      livePhotos: 1,
    }),
  )
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_SIGNATURE')
})

test('timeout returns usable partial resources and marks timeout in diagnostics', async () => {
  vi.useFakeTimers()
  const emit = vi.fn()
  const controller = new AbortController()
  const running = runParseStrategies(
    [
      {
        name: 'partial',
        run: async () => ({
          video: { mediaType: 'image', images: [{ url: 'https://images/1' }] },
          imagesComplete: false,
        }),
      },
      {
        name: 'slow',
        run: (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      },
    ],
    controller.signal,
    { requestId: 'test', version: 'test', emit },
  )
  await vi.advanceTimersByTimeAsync(100)
  controller.abort(new DOMException('timeout', 'TimeoutError'))
  expect((await running).images).toHaveLength(1)
  expect(emit).toHaveBeenCalledWith(
    'parse_selection',
    expect.objectContaining({
      reason: 'timeout',
      outcome: 'success',
    }),
  )
  expect(vi.getTimerCount()).toBe(0)
})

test('client cancellation is diagnosed separately from a failed strategy', async () => {
  const emit = vi.fn()
  const controller = new AbortController()
  const running = runParseStrategies(
    [
      {
        name: 'slow',
        run: (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      },
    ],
    controller.signal,
    { requestId: 'test', version: 'test', emit },
  )
  const rejected = expect(running).rejects.toHaveProperty('name', 'AbortError')
  controller.abort()
  await rejected
  expect(emit).toHaveBeenCalledWith(
    'parse_selection',
    expect.objectContaining({
      reason: 'cancelled',
      outcome: 'cancelled',
    }),
  )
})

test('frontend errors include a server request ID without changing successful payloads', async () => {
  const id = crypto.randomUUID()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { success: false, error: { message: '请重新解析' } },
        { status: 422, headers: { 'X-Request-ID': id } },
      ),
    ),
  )
  await expect(parseVideo(source)).rejects.toThrow(id)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, data: video })),
  )
  expect(await parseVideo(source)).toEqual(video)
})

test('frontend does not display untrusted correlation header text', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('gateway', {
          status: 502,
          headers: { 'X-Request-ID': 'PRIVATE_HEADER_TEXT' },
        }),
    ),
  )
  await expect(parseVideo(source)).rejects.not.toThrow('PRIVATE_HEADER_TEXT')
})

test('raw exception content is excluded from application error logs', () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  errorResponse(new Error('https://media/?signature=PRIVATE_SIGNATURE'), 'download')
  expect(JSON.stringify(errors.mock.calls)).not.toContain('PRIVATE_SIGNATURE')
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  createDiagnostics({ id: 'invalid\r\nheader' }).emit('test')
  expect(JSON.parse(logs.mock.calls[0][0]).version).toBe('unknown')
})
