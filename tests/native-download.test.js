import { afterEach, expect, test, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import worker from '../worker/src/index'
import { triggerDownload } from '../frontend/src/utils/download'
import { downloadErrorPage } from '../worker/src/utils/download-error-page'

const token = '12345678-1234-1234-1234-123456789abc'
const media = 'https://v.douyinvod.com/video.mp4'
const env = { DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } }
const request = (errorToken = token) =>
  new Request(
    'https://api.example.com/api/download?url=' +
      encodeURIComponent(media) +
      '&errorToken=' +
      encodeURIComponent(errorToken),
  )

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function browser() {
  const listeners = new Set()
  const frames = []
  vi.stubGlobal('window', {
    location: { href: 'https://frontend.example.com/' },
    addEventListener: (_event, callback) => listeners.add(callback),
    removeEventListener: (_event, callback) => listeners.delete(callback),
  })
  vi.stubGlobal('document', {
    createElement: (tag) => {
      expect(tag).toBe('iframe')
      return { contentWindow: {}, remove: vi.fn() }
    },
    body: { appendChild: (frame) => frames.push(frame) },
  })
  return {
    frames,
    listeners,
    dispatch(frame, data, override = {}) {
      for (const callback of listeners)
        callback({
          origin: new URL(frame.src).origin,
          source: frame.contentWindow,
          data,
          ...override,
        })
    },
  }
}

test('expired native downloads return a protected error document; ordinary API requests keep JSON', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('private upstream error', { status: 403 })),
  )
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(422)
  expect(response.headers.get('Content-Disposition')).toBeNull()
  expect(response.headers.get('Content-Type')).toContain('text/html')
  const html = await response.text()
  expect(html).not.toContain('private upstream error')
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/)
  expect(response.headers.get('Content-Security-Policy')).toContain('nonce-' + script[1])
  const parent = { postMessage: vi.fn() }
  runInNewContext(script[2], { parent })
  expect(parent.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      token,
      code: 'MEDIA_UNAVAILABLE',
      requestId: response.headers.get('X-Request-ID'),
    }),
    '*',
  )
  for (const invalid of ['', '<script>']) {
    const ordinary = await worker.fetch(request(invalid), env)
    expect(ordinary.headers.get('Content-Type')).toContain('application/json')
    expect((await ordinary.json()).error.code).toBe('MEDIA_UNAVAILABLE')
  }
})

test('rate-limited native downloads report retry delay without contacting the media CDN', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await worker.fetch(request(), {
    DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: false }) },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
  expect(await response.text()).toContain('"retryAfter":"60"')
  expect(fetch).not.toHaveBeenCalled()
})

test('native downloads still stream media responses without fetching or buffering a second time', async () => {
  let ended = false
  const upstream = new ReadableStream({
    pull(controller) {
      if (!ended) {
        ended = true
        controller.enqueue(new Uint8Array([1, 2, 3]))
      } else controller.close()
    },
  })
  const fetch = vi.fn(
    async () => new Response(upstream, { headers: { 'Content-Type': 'video/mp4' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const response = await worker.fetch(request(), env)
  expect(response.headers.get('Content-Disposition')).toContain('attachment')
  expect(response.headers.get('Content-Type')).toBe('video/mp4')
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('download feedback authenticates origin, source and token and cleans up on failure', () => {
  const { frames, listeners, dispatch } = browser()
  const onError = vi.fn()
  triggerDownload(media, 'test.mp4', onError)
  const frame = frames[0]
  const data = {
    type: 'video-parser-download-error',
    token: new URL(frame.src).searchParams.get('errorToken'),
    code: 'RATE_LIMITED',
    message: '限流',
    retryAfter: '60',
    requestId: token,
  }
  dispatch(frame, data, { origin: 'https://attacker.example.com' })
  dispatch(frame, data, { source: {} })
  dispatch(frame, { ...data, token: 'wrong' })
  dispatch(frame, { ...data, message: {} })
  expect(onError).not.toHaveBeenCalled()
  expect(listeners.size).toBe(1)
  dispatch(frame, data)
  expect(onError).toHaveBeenCalledWith({
    code: 'RATE_LIMITED',
    message: '请求过于频繁，请等待约 60 秒后重试（请求编号：' + token + '）',
  })
  expect(listeners.size).toBe(0)
  expect(frame.remove).toHaveBeenCalledTimes(1)
})

test('clearing a native download removes its frame and prevents stale feedback', () => {
  const { frames, listeners, dispatch } = browser()
  const onError = vi.fn()
  const dispose = triggerDownload(media, 'test.mp4', onError)
  const frame = frames[0]
  dispose()
  expect(listeners.size).toBe(0)
  dispatch(frame, {
    type: 'video-parser-download-error',
    token: new URL(frame.src).searchParams.get('errorToken'),
    code: 'MEDIA_UNAVAILABLE',
    message: 'expired',
  })
  expect(onError).not.toHaveBeenCalled()
  expect(frame.remove).toHaveBeenCalledTimes(1)
})

test('error documents escape HTML and inline script content without changing the reported message', async () => {
  const message = '</script><img src=x onerror=alert(1)> & "test"'
  const response = await downloadErrorPage(
    Response.json({ error: { code: 'INVALID_URL', message } }, { status: 400 }),
    token,
    { requestId: token, version: 'test', emit: () => {} },
  )
  const html = await response.text()
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;/script&gt;')
  const parent = { postMessage: vi.fn() }
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], { parent })
  expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ message }), '*')
})
