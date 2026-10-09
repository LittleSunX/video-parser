import { afterEach, expect, test, vi } from 'vitest'
import worker from '../worker/src/index'
import {
  createDiagnostics,
  createUpstreamAttempt,
  withDiagnostics,
} from '../worker/src/utils/diagnostics'
import { runParseStrategies } from '../worker/src/parsers/douyin/strategies'
import { DouyinParser } from '../worker/src/parsers/douyin'
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
  expect(result).toEqual({
    ...partial,
    imagesComplete: false,
    parseStatus: 'unverified',
    parseReason: 'exhausted',
  })
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

const recordsFrom = (logs) =>
  logs.mock.calls
    .filter(([message]) => typeof message === 'string' && message.startsWith('{'))
    .map(([message]) => JSON.parse(message))

test('upstream attempts separate header, body and extraction time and emit once', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const emit = vi.fn()
  const diagnostic = createUpstreamAttempt(
    { requestId: 'test', version: 'test', emit },
    'web-detail',
    'web-detail',
    2,
  )
  const response = await diagnostic.response(async () => {
    vi.setSystemTime(1012)
    return new Response('PRIVATE_BODY', { status: 200 })
  })
  const text = await diagnostic.read(async () => {
    vi.setSystemTime(1040)
    return response.text()
  })
  expect(
    diagnostic.extract(() => {
      vi.setSystemTime(1047)
      return text.length
    }),
  ).toBe(12)
  diagnostic.result('success')
  diagnostic.finish()
  diagnostic.finish()
  expect(emit).toHaveBeenCalledExactlyOnceWith('upstream_attempt', {
    strategy: 'web-detail',
    endpoint: 'web-detail',
    attempt: 2,
    status: 200,
    result: 'success',
    waitMs: 12,
    readMs: 28,
    extractMs: 7,
    durationMs: 47,
  })
  expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_BODY')
})

test.each([
  ['wait', new TypeError('PRIVATE_NETWORK_URL'), 'network_error'],
  ['read', new TypeError('PRIVATE_SIGNED_MEDIA_URL'), 'read_error'],
  ['extract', new Error('PRIVATE_WORK_TITLE'), 'extract_error'],
  ['extract', new SyntaxError('PRIVATE_JSON'), 'invalid_json'],
  ['wait', new DOMException('PRIVATE_TIMEOUT', 'TimeoutError'), 'timeout'],
  ['read', new DOMException('PRIVATE_CANCEL', 'AbortError'), 'cancelled'],
])(
  'failed %s attempts retain measured time and a fixed %s category',
  async (phase, error, result) => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const emit = vi.fn()
    const diagnostic = createUpstreamAttempt(
      { requestId: 'test', version: 'test', emit },
      'web-detail',
      'web-detail',
      1,
    )
    const fail = () => {
      vi.setSystemTime(1030)
      throw error
    }
    try {
      if (phase === 'wait') await diagnostic.response(fail)
      else {
        await diagnostic.response(async () => new Response('PRIVATE_BODY'))
        if (phase === 'read') await diagnostic.read(fail)
        else diagnostic.extract(fail)
      }
    } catch (caught) {
      diagnostic.fail(caught)
    } finally {
      diagnostic.finish()
    }
    const fields = emit.mock.calls[0][1]
    expect(fields).toMatchObject({ result, durationMs: 30, [phase + 'Ms']: 30 })
    expect(fields.status).toBe(phase === 'wait' ? undefined : 200)
    expect(JSON.stringify(emit.mock.calls)).not.toContain('PRIVATE_')
  },
)

test('diagnostic serialization rejects arbitrary fields and dynamic labels', () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const trace = createDiagnostics()
  trace.emit('PRIVATE_EVENT', {
    strategy: 'PRIVATE_STRATEGY',
    endpoint: 'https://PRIVATE_ENDPOINT/?signature=PRIVATE_SIGNATURE',
    result: 'PRIVATE_RESULT',
    outcome: 'PRIVATE_OUTCOME',
    code: 'https://PRIVATE_EXCEPTION',
    sourceUrl: source,
    title: video.title,
    url: video.videoUrl,
    error: new Error('PRIVATE_ERROR'),
    durationMs: Number.NaN,
    readMs: -1,
    attempt: 3,
    hasMusic: true,
  })
  expect(recordsFrom(logs)).toEqual([
    {
      event: 'unknown_event',
      requestId: trace.requestId,
      version: 'unknown',
      attempt: 3,
      hasMusic: true,
    },
  ])
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com/)
})

test('all existing failed requests have fixed endpoint labels and unchanged retry counts', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const fetch = vi.fn(async () => new Response('PRIVATE_SIGNED_URL', { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  await expect(
    new DouyinParser().parse(source, undefined, createDiagnostics()),
  ).rejects.toMatchObject({ code: 'VIDEO_RESOURCE_NOT_FOUND' })
  expect(fetch).toHaveBeenCalledTimes(15)
  const attempts = recordsFrom(logs).filter((record) => record.event === 'upstream_attempt')
  expect(attempts.map(({ strategy, endpoint, attempt }) => [strategy, endpoint, attempt])).toEqual([
    ['web-detail', 'web-detail', 1],
    ['web-detail', 'web-detail', 2],
    ['web-detail', 'web-detail', 3],
    ['mobile-feed', 'feed-amemv-6383', 1],
    ['mobile-feed', 'feed-amemv-1128', 2],
    ['mobile-feed', 'feed-snssdk-6383', 3],
    ['mobile-feed', 'feed-snssdk-1128', 4],
    ['mobile-ssr', 'source-page', 1],
    ['mobile-ssr', 'share-video', 2],
    ['mobile-ssr', 'share-video-app', 3],
    ['mobile-ssr', 'share-video-ssr', 4],
    ['mobile-ssr', 'share-note', 5],
    ['mobile-ssr', 'share-slides', 6],
    ['mobile-ssr', 'mobile-note', 7],
    ['page-meta', 'current-page', 1],
  ])
  expect(
    attempts.every(
      ({ status, result, readMs, extractMs }) =>
        status === 403 && result === 'http_error' && readMs === 0 && extractMs === 0,
    ),
  ).toBe(true)
  expect(recordsFrom(logs).filter((record) => record.event === 'parse_first_usable')).toHaveLength(
    0,
  )
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com/)
})

const privateItem = {
  aweme_id: '123',
  desc: video.title,
  author: { nickname: 'PRIVATE_AUTHOR' },
  video: {
    play_addr: { url_list: [video.videoUrl] },
    cover: { url_list: ['https://p.douyinpic.com/cover?signature=PRIVATE_COVER'] },
  },
  music: {
    title: 'PRIVATE_MUSIC_TITLE',
    play_url: { url_list: ['https://sf.snssdk.com/music?signature=PRIVATE_MUSIC'] },
  },
}

test('primary attempt outcomes preserve returned author, cover and music without extra requests', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('  '))
    .mockResolvedValueOnce(new Response('PRIVATE_INVALID_JSON'))
    .mockResolvedValueOnce(Response.json({ aweme_detail: privateItem }))
  vi.stubGlobal('fetch', fetch)
  const result = await new DouyinParser().parse(source, undefined, createDiagnostics())
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(result).toMatchObject({
    author: privateItem.author.nickname,
    cover: privateItem.video.cover.url_list[0],
    musicUrl: privateItem.music.play_url.url_list[0],
    musicTitle: privateItem.music.title,
    videoUrl: video.videoUrl,
    parseStatus: 'complete',
  })
  const records = recordsFrom(logs)
  expect(
    records.filter(({ event }) => event === 'upstream_attempt').map(({ result }) => result),
  ).toEqual(['empty_response', 'invalid_json', 'success'])
  expect(records.find(({ event }) => event === 'parse_first_usable')).toMatchObject({
    strategy: 'web-detail',
    videos: 1,
    hasAuthor: true,
    hasCover: true,
    hasMusic: true,
  })
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com|signature=/)
})

test('feed attempts distinguish malformed JSON, missing items and body read errors', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const responses = [
    ...Array.from({ length: 3 }, () => new Response('PRIVATE_ERROR_BODY', { status: 403 })),
    new Response('PRIVATE_BAD_JSON'),
    Response.json({ aweme_detail: { ...privateItem, aweme_id: '456' } }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('PRIVATE_READ_EXCEPTION'))
        },
      }),
    ),
    Response.json({ aweme_detail: privateItem }),
  ]
  const fetch = vi.fn(async () => responses.shift())
  vi.stubGlobal('fetch', fetch)
  expect(await new DouyinParser().parse(source, undefined, createDiagnostics())).toMatchObject({
    author: privateItem.author.nickname,
    musicUrl: privateItem.music.play_url.url_list[0],
  })
  expect(fetch).toHaveBeenCalledTimes(7)
  expect(
    recordsFrom(logs)
      .filter(({ event, strategy }) => event === 'upstream_attempt' && strategy === 'mobile-feed')
      .map(({ result }) => result),
  ).toEqual(['invalid_json', 'item_missing', 'read_error', 'success'])
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com|signature=/)
})

const routerHtml = (data) =>
  '<script>window._ROUTER_DATA = ' + JSON.stringify(data) + '</script>' + ' '.repeat(1000)

test('SSR attempts distinguish page extraction outcomes without losing metadata', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const responses = [
    ...Array.from({ length: 7 }, () => new Response('PRIVATE_ERROR_BODY', { status: 403 })),
    new Response('PRIVATE_SMALL_PAGE'),
    new Response('PRIVATE_NO_ROUTER' + ' '.repeat(1000)),
    new Response(routerHtml({ notice: 'PRIVATE_FILTER_REASON' })),
    new Response(routerHtml({ aweme_detail: { aweme_id: '123', video: {} } })),
    new Response(routerHtml({ aweme_detail: privateItem })),
  ]
  const fetch = vi.fn(async () => responses.shift())
  vi.stubGlobal('fetch', fetch)
  expect(await new DouyinParser().parse(source, undefined, createDiagnostics())).toMatchObject({
    author: privateItem.author.nickname,
    cover: privateItem.video.cover.url_list[0],
    musicTitle: privateItem.music.title,
    musicUrl: privateItem.music.play_url.url_list[0],
  })
  expect(fetch).toHaveBeenCalledTimes(12)
  expect(
    recordsFrom(logs)
      .filter(({ event, strategy }) => event === 'upstream_attempt' && strategy === 'mobile-ssr')
      .map(({ result }) => result),
  ).toEqual([
    'page_too_small',
    'router_data_missing',
    'item_missing',
    'resource_missing',
    'success',
  ])
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com|signature=/)
})

test.each([
  ['<meta property="og:video" content="PRIVATE_MEDIA">', 'page_mismatch'],
  ['<a href="/video/123">PRIVATE_TITLE</a>', 'resource_missing'],
])('page metadata failures use fixed categories', async (html, category) => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const fetch = vi.fn(
    async () =>
      new Response(fetch.mock.calls.length === 15 ? html : 'PRIVATE_ERROR_BODY', {
        status: fetch.mock.calls.length === 15 ? 200 : 403,
      }),
  )
  vi.stubGlobal('fetch', fetch)
  await expect(
    new DouyinParser().parse(source, undefined, createDiagnostics()),
  ).rejects.toMatchObject({ code: 'VIDEO_RESOURCE_NOT_FOUND' })
  expect(fetch).toHaveBeenCalledTimes(15)
  expect(
    recordsFrom(logs).find(
      ({ event, strategy }) => event === 'upstream_attempt' && strategy === 'page-meta',
    ),
  ).toMatchObject({ attempt: 1, status: 200, result: category })
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|douyin.com/)
})

test('first usable timing is emitted once and final timing retains quality and known live resources', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {})
  const trace = createDiagnostics()
  // Model the time spent reading input and resolving the short link before strategies start.
  await vi.advanceTimersByTimeAsync(100)
  const partial = {
    ...video,
    videoUrl: undefined,
    mediaType: 'image',
    author: 'PRIVATE_AUTHOR',
    cover: 'https://images/PRIVATE_COVER',
    musicUrl: 'https://audio/PRIVATE_MUSIC',
    musicTitle: 'PRIVATE_MUSIC_TITLE',
    images: [
      { url: 'https://images/PRIVATE_IMAGE', livePhotoUrl: video.videoUrl, watermarkFree: false },
    ],
  }
  const running = runParseStrategies(
    [
      {
        name: 'web-detail',
        run: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ video: partial, imagesComplete: true }), 40),
          ),
      },
      {
        name: 'mobile-feed',
        run: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  video: {
                    ...partial,
                    images: partial.images.map((image) => ({ ...image, watermarkFree: true })),
                  },
                  imagesComplete: true,
                }),
              500,
            ),
          ),
      },
    ],
    undefined,
    trace,
  )
  await vi.advanceTimersByTimeAsync(540)
  expect(await running).toMatchObject({
    author: partial.author,
    cover: partial.cover,
    musicUrl: partial.musicUrl,
    musicTitle: partial.musicTitle,
    images: [{ ...partial.images[0], watermarkFree: true }],
    imagesComplete: true,
    parseStatus: 'complete',
  })
  const records = recordsFrom(logs)
  const first = records.filter(({ event }) => event === 'parse_first_usable')
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({
    durationMs: 40,
    sinceRequestMs: 140,
    images: 1,
    livePhotos: 1,
    watermarkFreeImages: 0,
    imagesComplete: true,
    hasAuthor: true,
    hasCover: true,
    hasMusic: true,
  })
  expect(records.find(({ event }) => event === 'parse_selection')).toMatchObject({
    durationMs: 540,
    sinceRequestMs: 640,
    images: 1,
    livePhotos: 1,
    watermarkFreeImages: 1,
    imagesComplete: true,
    hasAuthor: true,
    hasCover: true,
    hasMusic: true,
  })
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/PRIVATE_|signature=/)
  expect(vi.getTimerCount()).toBe(0)
})
