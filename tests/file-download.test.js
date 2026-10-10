import { afterEach, expect, test, vi } from 'vitest'
import { effectScope } from 'vue'
import { useFileDownload } from '../frontend/src/composables/useFileDownload'
import { saveBlob } from '../frontend/src/utils/auto-download'
import { triggerDownload } from '../frontend/src/utils/download'
import { SINGLE_BUFFER_BYTES } from '../frontend/src/utils/download-buffer'

vi.mock('../frontend/src/utils/auto-download', async (importOriginal) => ({
  ...(await importOriginal()),
  saveBlob: vi.fn(),
}))
vi.mock('../frontend/src/utils/download', async (importOriginal) => ({
  ...(await importOriginal()),
  triggerDownload: vi.fn(() => vi.fn()),
}))

const scopes = []
function download(kind = 'audio') {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() =>
    useFileDownload({
      label: kind === 'audio' ? '背景音乐' : '封面',
      kind,
      getTarget: () => ({ url: 'https://media.douyinvod.com/' + kind, filename: kind + '.file' }),
      showNotice: vi.fn(),
    }),
  )
}

function streamResponse(options, { type = 'audio/mpeg', length } = {}) {
  let source
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        source = controller
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason), {
          once: true,
        })
      },
      cancel,
    }),
    {
      headers: {
        'Content-Type': type,
        ...(length ? { 'Content-Length': String(length) } : {}),
      },
    },
  )
  return { response, source, cancel, signal: options.signal }
}

function pendingResponse(options) {
  let resolveResponse
  const promise = new Promise((resolve, reject) => {
    const abort = () => reject(options.signal.reason)
    resolveResponse = (response) => {
      options.signal.removeEventListener('abort', abort)
      resolve(response)
    }
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
  return { promise, resolveResponse, signal: options.signal }
}

function expectProxyRequest(call, kind = 'audio') {
  const [url, options] = call
  const requestUrl = new URL(url, 'https://frontend.example.com')
  expect(requestUrl.pathname).toBe('/api/download')
  expect(requestUrl.searchParams.get('url')).toBe('https://media.douyinvod.com/' + kind)
  expect(requestUrl.searchParams.has('errorToken')).toBe(false)
  expect(options.credentials).toBe('omit')
  expect(options.headers).toBeUndefined()
  expect(options.method).toBeUndefined()
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

for (const knownLength of [true, false]) {
  test(`music reports streamed progress with one GET (Content-Length=${knownLength})`, async () => {
    let source
    const fetch = vi.fn(async (_url, options) => {
      const stream = streamResponse(options, { length: knownLength ? 512 * 1024 : undefined })
      source = stream.source
      return stream.response
    })
    vi.stubGlobal('fetch', fetch)
    const music = download()
    const running = music.start()
    await music.start()
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe('https://media.douyinvod.com/audio')
    expect(options.headers).toBeUndefined()
    expect(options.method).toBeUndefined()
    expect(options.credentials).toBe('omit')
    expect(options.mode).toBe('cors')
    expect(options.referrerPolicy).toBe('no-referrer')
    source.enqueue(new Uint8Array(256 * 1024).fill(1))
    await vi.waitFor(() =>
      expect(music.status).toBe(knownLength ? '正在下载 50%' : '已接收 0.3 MB'),
    )
    expect(music.progress).toBe(knownLength ? 50 : undefined)
    expect(saveBlob).not.toHaveBeenCalled()
    source.enqueue(new Uint8Array(256 * 1024).fill(2))
    source.close()
    await running
    expect(music.state).toBe('handed-off')
    expect(music.downloading).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(triggerDownload).not.toHaveBeenCalled()
    expect(saveBlob).toHaveBeenCalledOnce()
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]
    expect(filename).toBe('audio.file')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes.byteLength).toBe(512 * 1024)
    expect(bytes[0]).toBe(1)
    expect(bytes[bytes.length - 1]).toBe(2)
  })
}

test('cover completes independently while music is cancelled during transfer', async () => {
  let musicSource
  let musicSignal
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      if (url === 'https://media.douyinvod.com/audio') {
        musicSignal = options.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              musicSource = controller
              options.signal.addEventListener('abort', () =>
                controller.error(options.signal.reason),
              )
            },
          }),
          { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '4' } },
        )
      }
      return new Response(new Uint8Array([5, 6]), { headers: { 'Content-Type': 'image/jpeg' } })
    }),
  )
  const music = download()
  const cover = download('image')
  const running = music.start()
  musicSource.enqueue(new Uint8Array([1, 2]))
  await vi.waitFor(() => expect(music.progress).toBe(50))
  await cover.start()
  expect(cover.state).toBe('handed-off')
  expect(music.state).toBe('receiving')
  expect(music.downloading).toBe(true)
  music.cancel()
  await running
  expect(musicSignal.aborted).toBe(true)
  expect(music.state).toBe('cancelled')
  expect(music.downloading).toBe(false)
  expect(cover.state).toBe('handed-off')
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(vi.mocked(saveBlob).mock.calls[0][1]).toBe('image.jpg')
  expect(triggerDownload).not.toHaveBeenCalled()
})

test('a stale response after reset cannot save a file or overwrite a new download', async () => {
  let resolveOld
  const fetch = vi
    .fn()
    .mockImplementationOnce((_url, options) => {
      const pending = pendingResponse(options)
      resolveOld = pending.resolveResponse
      return pending.promise
    })
    .mockResolvedValueOnce(new Response('new', { headers: { 'Content-Type': 'audio/mpeg' } }))
  vi.stubGlobal('fetch', fetch)
  const music = download()
  const old = music.start()
  music.reset()
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(music.status).toBe('')
  await music.start()
  resolveOld(new Response('old', { headers: { 'Content-Type': 'audio/mpeg' } }))
  await old
  expect(music.state).toBe('handed-off')
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(await vi.mocked(saveBlob).mock.calls[0][0].text()).toBe('new')
})

test('cover keeps its original WebP bytes and uses the matching filename extension', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const fetch = vi.fn(
    async () => new Response(bytes, { headers: { 'Content-Type': 'image/webp' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const cover = download('image')
  await cover.start()
  expect(fetch).toHaveBeenCalledOnce()
  expectProxyRequest(fetch.mock.calls[0], 'image')
  const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]
  expect(filename).toBe('image.webp')
  expect(blob.type).toBe('image/webp')
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...bytes])
})

test.each([
  [429, 'application/json', false],
  [422, 'application/json', true],
  [200, 'text/html', true],
])(
  'HTTP %s (%s) is reported without saving or automatically retrying',
  async (status, type, reparse) => {
    const fetch = vi.fn(
      async () => new Response('error', { status, headers: { 'Content-Type': type } }),
    )
    vi.stubGlobal('fetch', fetch)
    const cover = download('image')
    await cover.start()
    expect(cover.state).toBe('failed')
    expect(cover.needsReparse).toBe(reparse)
    expect(cover.downloading).toBe(false)
    expect(saveBlob).not.toHaveBeenCalled()
    expect(triggerDownload).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expectProxyRequest(fetch.mock.calls[0], 'image')
  },
)

test('browser fallback is explicit and clearing it discards stale native error feedback', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline')
    }),
  )
  const music = download()
  await music.start()
  expect(music.state).toBe('failed')
  expect(triggerDownload).not.toHaveBeenCalled()
  music.startBrowserDownload()
  expect(music.state).toBe('fallback')
  const [url, filename, onError] = vi.mocked(triggerDownload).mock.calls[0]
  expect(url).toBe('https://media.douyinvod.com/audio')
  expect(filename).toBe('audio.file')
  const dispose = vi.mocked(triggerDownload).mock.results[0].value
  music.reset()
  expect(dispose).toHaveBeenCalledOnce()
  onError({ code: 'MEDIA_UNAVAILABLE', message: 'expired' })
  expect(music.status).toBe('')
  expect(music.needsReparse).toBe(false)
})

test.each([
  ['CORS or network rejection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['HTTP 403', () => Promise.resolve(new Response('forbidden', { status: 403 }))],
  [
    'non-media response',
    () => Promise.resolve(new Response('login', { headers: { 'Content-Type': 'text/html' } })),
  ],
])(
  'music falls back once after %s and saves only the complete proxy response',
  async (_name, direct) => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(direct)
      .mockResolvedValueOnce(
        new Response('proxy music', { headers: { 'Content-Type': 'audio/mpeg' } }),
      )
    vi.stubGlobal('fetch', fetch)
    const music = download()
    await music.start()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('https://media.douyinvod.com/audio')
    expectProxyRequest(fetch.mock.calls[1])
    expect(music.state).toBe('handed-off')
    expect(music.needsReparse).toBe(false)
    expect(saveBlob).toHaveBeenCalledOnce()
    expect(await vi.mocked(saveBlob).mock.calls[0][0].text()).toBe('proxy music')
    expect(triggerDownload).not.toHaveBeenCalled()
  },
)

test('a failed proxy response is reported after one fallback without another request', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(new Response('expired', { status: 422 }))
  vi.stubGlobal('fetch', fetch)
  const music = download()
  await music.start()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(music.state).toBe('failed')
  expect(music.needsReparse).toBe(true)
  expect(music.downloading).toBe(false)
  expect(saveBlob).not.toHaveBeenCalled()
})

test.each([429, 503])('music HTTP %s is busy and does not fall back', async (status) => {
  const fetch = vi.fn(async () => new Response('busy', { status }))
  vi.stubGlobal('fetch', fetch)
  const music = download()
  await music.start()
  expect(fetch).toHaveBeenCalledOnce()
  expect(music.state).toBe('failed')
  expect(music.needsReparse).toBe(false)
  expect(saveBlob).not.toHaveBeenCalled()
})

test('music exceeding the buffer limit does not fall back', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('oversized music', {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(SINGLE_BUFFER_BYTES + 1),
        },
      }),
  )
  vi.stubGlobal('fetch', fetch)
  const music = download()
  await music.start()
  expect(fetch).toHaveBeenCalledOnce()
  expect(music.state).toBe('failed')
  expect(music.status).toContain('文件较大')
  expect(music.needsReparse).toBe(false)
  expect(saveBlob).not.toHaveBeenCalled()
})

test('partial direct music is discarded and its progress resets before proxy download', async () => {
  let direct
  let proxy
  const fetch = vi
    .fn()
    .mockImplementationOnce(async (_url, options) => {
      direct = streamResponse(options, { length: 1024 * 1024 })
      return direct.response
    })
    .mockImplementationOnce(async (_url, options) => {
      proxy = pendingResponse(options)
      return proxy.promise
    })
  vi.stubGlobal('fetch', fetch)
  const music = download()
  const running = music.start()
  direct.source.enqueue(new Uint8Array(512 * 1024).fill(1))
  await vi.waitFor(() => expect(music.progress).toBe(50))
  direct.source.error(new TypeError('connection reset'))
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(direct.signal.aborted).toBe(true)
  expect(music.progress).toBeUndefined()
  expect(music.status).not.toContain('50%')
  expect(saveBlob).not.toHaveBeenCalled()
  proxy.resolveResponse(
    new Response('complete proxy', { headers: { 'Content-Type': 'audio/mpeg' } }),
  )
  await running
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(await vi.mocked(saveBlob).mock.calls[0][0].text()).toBe('complete proxy')
})

test.each([
  ['cancel', 'direct'],
  ['reset', 'direct'],
  ['cancel', 'proxy'],
  ['reset', 'proxy'],
])(
  '%s during %s music cannot trigger further fallback or save stale bytes',
  async (action, stage) => {
    vi.useFakeTimers()
    let active
    const fetch = vi.fn(async (_url, options) => {
      if (stage === 'proxy' && !active) {
        active = true
        throw new TypeError('Failed to fetch')
      }
      active = streamResponse(options)
      return active.response
    })
    vi.stubGlobal('fetch', fetch)
    const music = download()
    const running = music.start()
    await vi.advanceTimersByTimeAsync(0)
    active.source.enqueue(new Uint8Array(512 * 1024))
    await vi.advanceTimersByTimeAsync(0)
    expect(music.status).toBe('已接收 0.5 MB')
    music[action]()
    await running
    await vi.advanceTimersByTimeAsync(60000)
    expect(active.signal.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(stage === 'direct' ? 1 : 2)
    expect(saveBlob).not.toHaveBeenCalled()
    expect(music.downloading).toBe(false)
    expect(music.state).toBe(action === 'cancel' ? 'cancelled' : 'receiving')
    expect(music.status).toBe(action === 'cancel' ? '已取消背景音乐下载' : '')
  },
)

test('music switches to proxy after 8 seconds without a direct response', async () => {
  vi.useFakeTimers()
  let direct
  const fetch = vi
    .fn()
    .mockImplementationOnce((_url, options) => {
      direct = pendingResponse(options)
      return direct.promise
    })
    .mockResolvedValueOnce(new Response('proxy', { headers: { 'Content-Type': 'audio/mpeg' } }))
  vi.stubGlobal('fetch', fetch)
  const music = download()
  const running = music.start()
  await vi.advanceTimersByTimeAsync(7999)
  expect(fetch).toHaveBeenCalledOnce()
  expect(direct.signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await running
  expect(direct.signal.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  expectProxyRequest(fetch.mock.calls[1])
  expect(music.state).toBe('handed-off')
  expect(await vi.mocked(saveBlob).mock.calls[0][0].text()).toBe('proxy')
})

test('music stalled at 0.5 MB switches after 15 seconds and stops a stalled proxy after 45 seconds', async () => {
  vi.useFakeTimers()
  const streams = []
  const fetch = vi.fn(async (_url, options) => {
    const stream = streamResponse(options)
    streams.push(stream)
    return stream.response
  })
  vi.stubGlobal('fetch', fetch)
  const music = download()
  const running = music.start()
  await vi.advanceTimersByTimeAsync(0)
  streams[0].source.enqueue(new Uint8Array(512 * 1024).fill(1))
  await vi.advanceTimersByTimeAsync(0)
  expect(music.status).toBe('已接收 0.5 MB')
  await vi.advanceTimersByTimeAsync(14999)
  expect(fetch).toHaveBeenCalledOnce()
  expect(streams[0].signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(streams[0].signal.aborted).toBe(true)
  expect(music.progress).toBeUndefined()
  expect(music.status).not.toContain('0.5 MB')
  expect(saveBlob).not.toHaveBeenCalled()
  streams[1].source.enqueue(new Uint8Array(512 * 1024).fill(2))
  await vi.advanceTimersByTimeAsync(0)
  expect(music.status).toBe('已接收 0.5 MB')
  await vi.advanceTimersByTimeAsync(44999)
  expect(streams[1].signal.aborted).toBe(false)
  expect(music.downloading).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await running
  expect(streams[1].signal.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(music.state).toBe('failed')
  expect(music.status).toContain('超时')
  expect(music.downloading).toBe(false)
  expect(saveBlob).not.toHaveBeenCalled()
})

test('pending cancellation of partial direct music does not block the timed proxy fallback', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn(() => new Promise(() => {}))
  const directBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024).fill(1))
    },
    cancel,
  })
  const proxyBytes = new Uint8Array([9, 8, 7])
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(directBody, { headers: { 'Content-Type': 'audio/mpeg' } }))
    .mockResolvedValueOnce(new Response(proxyBytes, { headers: { 'Content-Type': 'audio/mpeg' } }))
  vi.stubGlobal('fetch', fetch)
  const music = download()
  const running = music.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(music.status).toBe('已接收 0.5 MB')
  await vi.advanceTimersByTimeAsync(14999)
  expect(fetch).toHaveBeenCalledOnce()
  expect(saveBlob).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await running
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(directBody.locked).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(2)
  expectProxyRequest(fetch.mock.calls[1])
  expect(music.state).toBe('handed-off')
  expect(music.downloading).toBe(false)
  expect(saveBlob).toHaveBeenCalledOnce()
  expect([...new Uint8Array(await vi.mocked(saveBlob).mock.calls[0][0].arrayBuffer())]).toEqual([
    ...proxyBytes,
  ])
})

test.each(['audio', 'image'])('%s proxy waits up to 30 seconds for its response', async (kind) => {
  vi.useFakeTimers()
  let proxy
  const fetch = vi.fn((_url, options) => {
    if (kind === 'audio' && !proxy) {
      proxy = true
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    proxy = pendingResponse(options)
    return proxy.promise
  })
  vi.stubGlobal('fetch', fetch)
  const item = download(kind)
  const running = item.start()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(29999)
  expect(proxy.signal.aborted).toBe(false)
  expect(item.downloading).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await running
  expect(proxy.signal.aborted).toBe(true)
  expect(item.state).toBe('failed')
  expect(item.status).toContain('超时')
  expect(fetch).toHaveBeenCalledTimes(kind === 'audio' ? 2 : 1)
  expect(saveBlob).not.toHaveBeenCalled()
})

test('cover proxy aborts a read that stops receiving data for 45 seconds', async () => {
  vi.useFakeTimers()
  let coverStream
  const fetch = vi.fn(async (_url, options) => {
    coverStream = streamResponse(options, { type: 'image/jpeg' })
    return coverStream.response
  })
  vi.stubGlobal('fetch', fetch)
  const cover = download('image')
  const running = cover.start()
  await vi.advanceTimersByTimeAsync(0)
  coverStream.source.enqueue(new Uint8Array([1, 2]))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(44999)
  expect(coverStream.signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await running
  expect(coverStream.signal.aborted).toBe(true)
  expect(cover.state).toBe('failed')
  expect(fetch).toHaveBeenCalledOnce()
  expectProxyRequest(fetch.mock.calls[0], 'image')
  expect(saveBlob).not.toHaveBeenCalled()
})

test.each(['direct music', 'proxy music', 'cover'])(
  '%s keeps receiving without a total time limit when its length is unknown',
  async (route) => {
    vi.useFakeTimers()
    const kind = route === 'cover' ? 'image' : 'audio'
    let media
    const fetch = vi.fn(async (_url, options) => {
      if (route === 'proxy music' && !media) {
        media = true
        throw new TypeError('Failed to fetch')
      }
      media = streamResponse(options, { type: kind === 'audio' ? 'audio/mpeg' : 'image/jpeg' })
      return media.response
    })
    vi.stubGlobal('fetch', fetch)
    const item = download(kind)
    const running = item.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 16; index++) {
      media.source.enqueue(new Uint8Array([index]))
      await vi.advanceTimersByTimeAsync(10000)
      expect(media.signal.aborted).toBe(false)
      expect(item.downloading).toBe(true)
      expect(item.progress).toBeUndefined()
    }
    media.source.close()
    await running
    expect(fetch).toHaveBeenCalledTimes(route === 'proxy music' ? 2 : 1)
    expect(item.state).toBe('handed-off')
    expect(saveBlob).toHaveBeenCalledOnce()
    expect([...new Uint8Array(await vi.mocked(saveBlob).mock.calls[0][0].arrayBuffer())]).toEqual(
      Array.from({ length: 16 }, (_, index) => index),
    )
  },
)
