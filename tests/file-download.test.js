import { afterEach, expect, test, vi } from 'vitest'
import { effectScope } from 'vue'
import { useFileDownload } from '../frontend/src/composables/useFileDownload'
import { saveBlob } from '../frontend/src/utils/auto-download'
import { triggerDownload } from '../frontend/src/utils/download'

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

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

for (const knownLength of [true, false]) {
  test(`music reports streamed progress with one GET (Content-Length=${knownLength})`, async () => {
    let source
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              source = controller
            },
          }),
          {
            headers: {
              'Content-Type': 'audio/mpeg',
              ...(knownLength ? { 'Content-Length': String(512 * 1024) } : {}),
            },
          },
        ),
    )
    vi.stubGlobal('fetch', fetch)
    const music = download()
    const running = music.start()
    await music.start()
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, options] = fetch.mock.calls[0]
    const requestUrl = new URL(url, 'https://frontend.example.com')
    expect(requestUrl.pathname).toBe('/api/download')
    expect(requestUrl.searchParams.get('url')).toBe('https://media.douyinvod.com/audio')
    expect(requestUrl.searchParams.has('errorToken')).toBe(false)
    expect(options.headers).toBeUndefined()
    expect(options.method).toBeUndefined()
    expect(options.credentials).toBe('omit')
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
      if (url.includes(encodeURIComponent('https://media.douyinvod.com/audio'))) {
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
    .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
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

test('proxy owns timeouts so slow connections and transfers are not interrupted earlier than native downloads', async () => {
  vi.useFakeTimers()
  let resolveResponse
  let source
  const fetch = vi.fn(() => new Promise((resolve) => (resolveResponse = resolve)))
  vi.stubGlobal('fetch', fetch)
  const music = download()
  const running = music.start()
  const signal = fetch.mock.calls[0][1].signal
  await vi.advanceTimersByTimeAsync(60000)
  expect(signal.aborted).toBe(false)
  resolveResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller
        },
      }),
      { headers: { 'Content-Type': 'audio/mpeg' } },
    ),
  )
  await vi.advanceTimersByTimeAsync(0)
  for (let index = 0; index < 7; index++) {
    source.enqueue(new Uint8Array([index]))
    await vi.advanceTimersByTimeAsync(60000)
    expect(signal.aborted).toBe(false)
    expect(music.downloading).toBe(true)
  }
  source.close()
  await running
  expect(music.state).toBe('handed-off')
  expect(saveBlob).toHaveBeenCalledOnce()
})

test('cover keeps its original WebP bytes and uses the matching filename extension', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'image/webp' } })),
  )
  const cover = download('image')
  await cover.start()
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
    const music = download()
    await music.start()
    expect(music.state).toBe('failed')
    expect(music.needsReparse).toBe(reparse)
    expect(music.downloading).toBe(false)
    expect(saveBlob).not.toHaveBeenCalled()
    expect(triggerDownload).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
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
