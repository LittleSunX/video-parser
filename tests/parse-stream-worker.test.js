import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import worker from '../worker/src/index'
import { parseVideo } from '../worker/src/services/parse-service'
import { AppError } from '../worker/src/errors/app-error'
import { errorResponse } from '../worker/src/utils/error-response'

vi.mock('../worker/src/services/parse-service', () => ({ parseVideo: vi.fn() }))

const source = 'https://www.douyin.com/video/123'
const allowed = { limit: vi.fn(async () => ({ success: true })) }
const env = {
  PARSE_RATE_LIMITER: allowed,
  DOWNLOAD_RATE_LIMITER: allowed,
  CF_VERSION_METADATA: { id: 'version-123' },
}
const preview = {
  platform: 'douyin',
  mediaType: 'image',
  videoId: '123',
  sourceUrl: source,
  title: '作品',
  author: '作者',
  cover: 'https://p.douyinpic.com/cover',
  musicUrl: 'https://sf.snssdk.com/music',
  musicTitle: '音乐',
  images: [
    {
      url: 'https://p.douyinpic.com/one',
      livePhotoUrl: 'https://v.douyinvod.com/live',
      watermarkFree: false,
    },
  ],
  imagesComplete: true,
}
const final = {
  ...preview,
  images: [{ ...preview.images[0], watermarkFree: true }],
  parseStatus: 'complete',
  parseReason: 'complete',
}
function request(accept = 'application/x-ndjson', options = {}) {
  return new Request('https://api.example.com/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify({ url: source }),
    ...options,
  })
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const readEvent = async (reader) =>
  JSON.parse(new TextDecoder().decode((await reader.read()).value))
const events = async (response) =>
  (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(parseVideo).mockReset()
  allowed.limit.mockClear()
})
afterEach(() => vi.restoreAllMocks())

test('one parse sends early preview and final metadata/known live resources in the same response', async () => {
  const completion = deferred()
  vi.mocked(parseVideo).mockImplementation(async (_input, _signal, _trace, onPreview) => {
    onPreview({ ...preview, parseStatus: 'complete', parseReason: 'complete' })
    return completion.promise
  })
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8')
  expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
  expect(response.headers.get('X-Worker-Version')).toBe('version-123')
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-ID')
  expect(allowed.limit).toHaveBeenCalledTimes(1)
  expect(parseVideo).toHaveBeenCalledTimes(1)
  const reader = response.body.getReader()
  expect(await readEvent(reader)).toEqual({ type: 'preview', data: preview })
  completion.resolve(final)
  expect(await readEvent(reader)).toEqual({ type: 'result', data: final })
  expect((await reader.read()).done).toBe(true)
  expect(parseVideo).toHaveBeenCalledTimes(1)
  const fields = parseVideo.mock.calls[0]
  expect(fields[0]).toBe(source)
  expect(fields[1]).toBeInstanceOf(AbortSignal)
  expect(fields[2].requestId).toBe(response.headers.get('X-Request-ID'))
  expect(fields[3]).toBeTypeOf('function')
})

test.each([
  'application/json',
  '*/*',
  'application/x-ndjson;q=0',
  'application/x-ndjson;q=invalid',
])('unrequested streaming keeps the original JSON payload (%s)', async (accept) => {
  vi.mocked(parseVideo).mockResolvedValue(final)
  const response = await worker.fetch(request(accept), env)
  expect(response.headers.get('Content-Type')).toContain('application/json')
  expect(await response.json()).toEqual({ success: true, data: final })
  expect(parseVideo).toHaveBeenCalledTimes(1)
  expect(parseVideo.mock.calls[0]).toHaveLength(3)
})

test('explicit NDJSON in a media list supports form input without another parse call', async () => {
  vi.mocked(parseVideo).mockResolvedValue(final)
  const response = await worker.fetch(
    request('application/json, Application/X-NDJSON;q=0.8', {
      headers: {
        Accept: 'application/json, Application/X-NDJSON;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ url: source }),
    }),
    env,
  )
  expect(await events(response)).toEqual([{ type: 'result', data: final }])
  expect(parseVideo).toHaveBeenCalledTimes(1)
})

test.each([
  [JSON.stringify({ url: '' }), 400],
  ['PRIVATE_INVALID_JSON', 400],
  [JSON.stringify({ url: 'https://example.com/video/123' }), 400],
  [JSON.stringify({ url: 'http://www.douyin.com/video/123' }), 400],
])('invalid input retains an ordinary HTTP error before the stream opens', async (body, status) => {
  const response = await worker.fetch(request('application/x-ndjson', { body }), env)
  expect(response.status).toBe(status)
  expect(response.headers.get('Content-Type')).toContain('application/json')
  expect((await response.json()).success).toBe(false)
  expect(parseVideo).not.toHaveBeenCalled()
})

test('rate limits retain HTTP 429 and retry headers before the stream opens', async () => {
  const response = await worker.fetch(request(), {
    ...env,
    PARSE_RATE_LIMITER: { limit: async () => ({ success: false }) },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
  expect(response.headers.get('Content-Type')).toContain('application/json')
  expect((await response.json()).error.code).toBe('RATE_LIMITED')
  expect(parseVideo).not.toHaveBeenCalled()
})

test.each([
  new AppError('PARSE_FAILED', 'PRIVATE_SIGNED_MEDIA_URL', 422),
  new Error('PRIVATE_TITLE_AND_SIGNATURE'),
])('stream errors reuse the public API error and terminate without a result', async (error) => {
  vi.mocked(parseVideo).mockRejectedValue(error)
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(200)
  const messages = await events(response)
  expect(messages).toEqual([
    { type: 'error', error: (await errorResponse(error, 'parse').json()).error },
  ])
  expect(JSON.stringify(messages)).not.toContain('PRIVATE_')
  expect(parseVideo).toHaveBeenCalledTimes(1)
})

test('a failure after preview emits its public error without a misleading final result', async () => {
  const completion = deferred()
  vi.mocked(parseVideo).mockImplementation(async (_input, _signal, _trace, onPreview) => {
    onPreview(preview)
    return completion.promise
  })
  const response = await worker.fetch(request(), env)
  const reader = response.body.getReader()
  expect((await readEvent(reader)).type).toBe('preview')
  completion.reject(new AppError('PARSE_TIMEOUT', '解析超时，请稍后重试', 504))
  expect(await readEvent(reader)).toEqual({
    type: 'error',
    error: { code: 'PARSE_TIMEOUT', message: '解析超时，请稍后重试' },
  })
  expect((await reader.read()).done).toBe(true)
})

test('reader cancellation aborts the same parse task and suppresses late messages', async () => {
  let taskSignal
  let onPreview
  const completion = deferred()
  vi.mocked(parseVideo).mockImplementation(async (_input, signal, _trace, previewCallback) => {
    taskSignal = signal
    onPreview = previewCallback
    previewCallback(preview)
    return completion.promise
  })
  const response = await worker.fetch(request(), env)
  const reader = response.body.getReader()
  expect((await readEvent(reader)).type).toBe('preview')
  await reader.cancel()
  expect(taskSignal.aborted).toBe(true)
  expect(() => onPreview(preview)).not.toThrow()
  completion.resolve(final)
  await Promise.resolve()
  expect((await reader.read()).done).toBe(true)
  expect(parseVideo).toHaveBeenCalledTimes(1)
})

test('request cancellation propagates to a pending read and its parse task', async () => {
  const cancellation = new AbortController()
  let taskSignal
  vi.mocked(parseVideo).mockImplementation((_input, signal) => {
    taskSignal = signal
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    )
  })
  const response = await worker.fetch(
    request('application/x-ndjson', { signal: cancellation.signal }),
    env,
  )
  const reader = response.body.getReader()
  const rejected = expect(reader.read()).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
  cancellation.abort()
  await rejected
  expect(taskSignal.aborted).toBe(true)
  expect(parseVideo).toHaveBeenCalledTimes(1)
})
