import { afterEach, expect, test, vi } from 'vitest'
import { effectScope } from 'vue'
import { parseVideo } from '../frontend/src/api/video'
import { readParseStream } from '../frontend/src/api/parse-stream'
import { useVideoPage } from '../frontend/src/composables/useVideoPage'

const video = {
  platform: 'douyin',
  mediaType: 'image',
  videoId: '123',
  sourceUrl: 'https://www.douyin.com/note/123',
  title: '中文作品 🌄',
  author: '作者',
  cover: 'https://p.douyinpic.com/cover',
  musicUrl: 'https://sf.snssdk.com/music',
  musicTitle: '音乐',
  images: [{ url: 'https://p.douyinpic.com/a', watermarkFree: false }],
}
const final = {
  ...video,
  images: [
    { ...video.images[0], livePhotoUrl: 'https://v.douyinvod.com/live', watermarkFree: true },
  ],
  imagesComplete: true,
  parseStatus: 'complete',
  parseReason: 'complete',
}
const encode = (event) => new TextEncoder().encode(JSON.stringify(event) + '\n')
const scopes = []
function stream() {
  let writer
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        writer = controller
      },
      cancel,
    }),
    { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } },
  )
  return {
    response,
    cancel,
    get writer() {
      return writer
    },
  }
}
function page() {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  const scope = effectScope()
  scopes.push(scope)
  const app = scope.run(useVideoPage)
  app.input.value = video.sourceUrl
  return app
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('progressive parse uses one simple POST and preserves the final quality and metadata', async () => {
  const source = stream()
  const fetch = vi.fn(async (_url, options) => {
    const request = new Request('https://api.example.com/api/parse', options)
    expect([...request.headers.keys()]).toEqual(['accept', 'content-type'])
    expect(request.headers.get('Accept')).toBe('application/x-ndjson')
    expect(request.headers.get('Content-Type')).toContain('application/x-www-form-urlencoded')
    expect(await request.text()).toBe(new URLSearchParams({ url: video.sourceUrl }).toString())
    return source.response
  })
  vi.stubGlobal('fetch', fetch)
  const preview = vi.fn()
  const pending = parseVideo(video.sourceUrl, undefined, preview)
  const bytes = encode({ type: 'preview', data: video })
  // Split both a multibyte character and the newline framing across chunks.
  for (const byte of bytes) source.writer.enqueue(new Uint8Array([byte]))
  await vi.waitFor(() => expect(preview).toHaveBeenCalledExactlyOnceWith(video))
  source.writer.enqueue(encode({ type: 'result', data: final }))
  expect(await pending).toEqual(final)
  expect(fetch).toHaveBeenCalledOnce()
  expect(source.cancel).toHaveBeenCalledOnce()
})

test('a JSON response from an old Worker needs no second request', async () => {
  const fetch = vi.fn(async () => Response.json({ success: true, data: final }))
  vi.stubGlobal('fetch', fetch)
  const preview = vi.fn()
  expect(await parseVideo(video.sourceUrl, undefined, preview)).toEqual(final)
  expect(fetch).toHaveBeenCalledOnce()
  expect(preview).not.toHaveBeenCalled()
})

test('a preview cannot complete a truncated stream', async () => {
  const source = stream()
  const preview = vi.fn()
  const pending = readParseStream(source.response, undefined, preview)
  const rejected = expect(pending).rejects.toThrow('传输中断')
  source.writer.enqueue(encode({ type: 'preview', data: video }))
  source.writer.close()
  await rejected
  expect(preview).toHaveBeenCalledOnce()
})

test('public stream errors include the same correlation ID without retrying', async () => {
  const source = stream()
  const id = crypto.randomUUID()
  source.response.headers.set('X-Request-ID', id)
  const fetch = vi.fn(async () => source.response)
  vi.stubGlobal('fetch', fetch)
  const pending = parseVideo(video.sourceUrl, undefined, vi.fn())
  const rejected = expect(pending).rejects.toThrow('暂时无法获取（请求编号：' + id + '）')
  source.writer.enqueue(encode({ type: 'preview', data: video }))
  source.writer.enqueue(
    encode({ type: 'error', error: { code: 'PARSE_FAILED', message: '暂时无法获取' } }),
  )
  await rejected
  expect(fetch).toHaveBeenCalledOnce()
  expect(source.cancel).toHaveBeenCalledOnce()
})

test.each([
  '{broken}\n',
  JSON.stringify({ type: 'other' }) + '\n',
  JSON.stringify({ type: 'preview', data: { ...video, imagesComplete: true, images: [] } }) + '\n',
  ' '.repeat(2 * 1024 * 1024 + 1),
])('invalid or oversized frames are cancelled rather than exposed as results', async (text) => {
  const source = stream()
  const preview = vi.fn()
  const pending = readParseStream(source.response, undefined, preview)
  const rejected = expect(pending).rejects.toThrow()
  source.writer.enqueue(new TextEncoder().encode(text))
  await rejected
  expect(preview).not.toHaveBeenCalled()
  expect(source.cancel).toHaveBeenCalledOnce()
})

test('abort cancels a pending stream read without waiting for another chunk', async () => {
  const source = stream()
  const controller = new AbortController()
  const pending = readParseStream(source.response, controller.signal)
  const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError')
  controller.abort()
  await rejected
  expect(source.cancel).toHaveBeenCalledOnce()
})

test('abort during a preview prevents a final result in the same chunk from succeeding', async () => {
  const source = stream()
  const controller = new AbortController()
  const pending = readParseStream(source.response, controller.signal, () => controller.abort())
  const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError')
  source.writer.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ type: 'preview', data: video }) +
        '\n' +
        JSON.stringify({ type: 'result', data: final }) +
        '\n',
    ),
  )
  await rejected
})

test('an unresponsive cleanup does not hold a validated final result', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encode({ type: 'result', data: final }))
      },
      cancel() {
        return new Promise(() => {})
      },
    }),
  )
  expect(await readParseStream(response)).toEqual(final)
})

test('preview is visible while downloads remain locked until the final result', async () => {
  const source = stream()
  const fetch = vi.fn(async () => source.response)
  vi.stubGlobal('fetch', fetch)
  const app = page()
  const pending = app.handleParse()
  source.writer.enqueue(encode({ type: 'preview', data: { ...video, imagesComplete: false } }))
  await vi.waitFor(() => expect(app.previewing.value).toBe(true))
  expect(app.video.value.title).toBe(video.title)
  expect(app.loading.value).toBe(true)
  expect(app.parseWarning.value).toBe('')
  await app.musicDownload.start()
  await app.coverDownload.start()
  await app.handleDownloadAllOriginals()
  app.handleDownloadImage(0)
  expect(fetch).toHaveBeenCalledOnce()
  source.writer.enqueue(encode({ type: 'result', data: final }))
  await pending
  expect(app.video.value).toEqual(final)
  expect(app.previewing.value).toBe(false)
  expect(app.loading.value).toBe(false)
})

test.each(['cancel', 'error'])('a %s discards a provisional result', async (action) => {
  const source = stream()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => source.response),
  )
  const app = page()
  const pending = app.handleParse()
  source.writer.enqueue(encode({ type: 'preview', data: video }))
  await vi.waitFor(() => expect(app.previewing.value).toBe(true))
  if (action === 'cancel') app.cancelParse()
  else
    source.writer.enqueue(
      encode({ type: 'error', error: { code: 'PARSE_FAILED', message: '失败' } }),
    )
  await pending
  expect(app.video.value).toBe(null)
  expect(app.previewing.value).toBe(false)
  expect(app.loading.value).toBe(false)
  expect(app.errorMessage.value).toBe(action === 'cancel' ? '' : '失败')
})
