import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { unzipSync } from 'fflate'
import { useMediaDownloads } from '../frontend/src/composables/useMediaDownloads'
import { createBatchSession, downloadMediaArchive } from '../frontend/src/utils/batch-download'
import { saveBlob } from '../frontend/src/utils/auto-download'
import { buildDownloadUrl, triggerDownload } from '../frontend/src/utils/download'

vi.mock('../frontend/src/utils/auto-download', async (importOriginal) => ({
  ...(await importOriginal()),
  saveBlob: vi.fn(),
}))
vi.mock('../frontend/src/utils/download', async (importOriginal) => ({
  ...(await importOriginal()),
  triggerDownload: vi.fn(),
}))

const scopes = []
const videoUrl = 'https://v.douyinvod.com/video.mp4'
const liveUrl = 'https://v.douyinvod.com/live.mp4'
const jobs = [1, 2, 3].map((index) => ({
  url: 'https://v.douyinvod.com/' + index + '.mp4',
  filename: index + '.mp4',
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.mocked(saveBlob).mockReset().mockReturnValue('blob:timeout-policy')
  vi.mocked(triggerDownload)
    .mockReset()
    .mockImplementation(() => vi.fn())
})

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mediaDownloads(kind = 'video') {
  const scope = effectScope()
  scopes.push(scope)
  const app = scope.run(() =>
    useMediaDownloads(
      ref({
        platform: 'douyin',
        mediaType: kind === 'video' ? 'video' : 'image',
        videoId: '1234567890123456789',
        sourceUrl: 'https://www.douyin.com/video/1234567890123456789',
        title: '作品',
        videoUrl: kind === 'video' ? videoUrl : undefined,
        images: kind === 'live' ? [{ url: '', livePhotoUrl: liveUrl }] : undefined,
      }),
      vi.fn(),
    ),
  )
  return {
    app,
    start: () => (kind === 'video' ? app.handleDownloadVideo() : app.handleDownloadLivePhoto(0)),
  }
}

function mediaStream(options) {
  let source
  const cancel = vi.fn()
  const body = new ReadableStream({
    start(controller) {
      source = controller
    },
    cancel,
  })
  return {
    source,
    body,
    cancel,
    signal: options.signal,
    response: new Response(body, { headers: { 'Content-Type': 'video/mp4' } }),
  }
}

test.each(['video', 'live'])(
  '%s continues receiving beyond two minutes and saves its complete bytes without fallback',
  async (kind) => {
    let media
    const fetch = vi.fn(async (_url, options) => {
      media = mediaStream(options)
      return media.response
    })
    vi.stubGlobal('fetch', fetch)
    const { app, start } = mediaDownloads(kind)
    const running = start()
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 13; index++) {
      media.source.enqueue(new Uint8Array([index]))
      await vi.advanceTimersByTimeAsync(10000)
      expect(media.signal.aborted).toBe(false)
      expect(app.videoDownloading.value).toBe(true)
      expect(saveBlob).not.toHaveBeenCalled()
      expect(triggerDownload).not.toHaveBeenCalled()
    }
    media.source.close()
    await running
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      kind === 'video' ? videoUrl : liveUrl,
      expect.any(Object),
    )
    expect(app.downloadState.value).toBe('handed-off')
    expect(app.bufferBusy.value).toBe(false)
    expect(saveBlob).toHaveBeenCalledOnce()
    const bytes = await vi.mocked(saveBlob).mock.calls[0][0].arrayBuffer()
    expect([...new Uint8Array(bytes)]).toEqual(Array.from({ length: 13 }, (_, index) => index))
    expect(triggerDownload).not.toHaveBeenCalled()
    app.cancelVideoDownload()
    expect(vi.getTimerCount()).toBe(0)
  },
)

test.each([
  ['response', 8000],
  ['read', 15000],
])(
  'video %s still times out after %i ms and starts one native fallback',
  async (phase, timeout) => {
    let media
    let signal
    const fetch = vi.fn((_url, options) => {
      signal = options.signal
      if (phase === 'response') return new Promise(() => {})
      media = mediaStream(options)
      media.source.enqueue(new Uint8Array([99]))
      return Promise.resolve(media.response)
    })
    vi.stubGlobal('fetch', fetch)
    const { app, start } = mediaDownloads()
    const running = start()
    await vi.advanceTimersByTimeAsync(timeout - 1)
    expect(signal.aborted).toBe(false)
    expect(app.videoDownloading.value).toBe(true)
    expect(triggerDownload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await running
    expect(signal.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
    expect(triggerDownload).toHaveBeenCalledExactlyOnceWith(
      videoUrl,
      expect.stringMatching(/\.mp4$/),
      expect.any(Function),
    )
    expect(app.downloadState.value).toBe('fallback')
    expect(app.videoDownloading.value).toBe(false)
    expect(app.bufferBusy.value).toBe(false)
    expect(saveBlob).not.toHaveBeenCalled()
    if (media) {
      expect(media.cancel).toHaveBeenCalledOnce()
      expect(media.body.locked).toBe(false)
    }
    expect(vi.getTimerCount()).toBe(0)
  },
)

test.each([
  ['live', 'response'],
  ['video', 'read'],
])('cancelling %s during %s cannot save partial bytes or trigger fallback', async (kind, phase) => {
  let signal
  const fetch = vi.fn((_url, options) => {
    signal = options.signal
    if (phase === 'response') return new Promise(() => {})
    const media = mediaStream(options)
    media.source.enqueue(new Uint8Array([99]))
    return Promise.resolve(media.response)
  })
  vi.stubGlobal('fetch', fetch)
  const { app, start } = mediaDownloads(kind)
  const running = start()
  await vi.advanceTimersByTimeAsync(0)
  app.cancelVideoDownload()
  await running
  await vi.advanceTimersByTimeAsync(60000)
  expect(signal.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledOnce()
  expect(triggerDownload).not.toHaveBeenCalled()
  expect(saveBlob).not.toHaveBeenCalled()
  expect(app.downloadState.value).toBe('cancelled')
  expect(app.videoDownloading.value).toBe(false)
  expect(app.bufferBusy.value).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  ['response', 30000],
  ['read', 45000],
])(
  'a stalled ZIP proxy %s fails after %i ms and retries only unfinished files',
  async (phase, timeout) => {
    let recovered = false
    let proxy
    let signal
    const fetch = vi.fn(async (url, options) => {
      if (url === jobs[1].url) throw new TypeError('CORS')
      if (url === buildDownloadUrl(jobs[1].url, jobs[1].filename) && !recovered) {
        signal = options.signal
        if (phase === 'response') return new Promise(() => {})
        proxy = mediaStream(options)
        proxy.source.enqueue(new Uint8Array([99]))
        return proxy.response
      }
      const index = url === jobs[0].url ? 1 : url === jobs[2].url ? 3 : 2
      return new Response(new Uint8Array([index]), { headers: { 'Content-Type': 'video/mp4' } })
    })
    vi.stubGlobal('fetch', fetch)
    const session = createBatchSession(jobs)
    const onProgress = vi.fn()
    const running = downloadMediaArchive(
      jobs,
      '作品.zip',
      new AbortController().signal,
      onProgress,
      session,
    )
    const failed = expect(running).rejects.toHaveProperty('code', 'TIMEOUT')
    await vi.advanceTimersByTimeAsync(0)
    expect(session.nextIndex).toBe(1)
    const retained = session.files.get(jobs[0].filename)
    expect(await retained.text()).toBe(String.fromCharCode(1))
    await vi.advanceTimersByTimeAsync(timeout - 1)
    expect(signal.aborted).toBe(false)
    expect(saveBlob).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(signal.aborted).toBe(true)
    expect(session.nextIndex).toBe(1)
    expect(session.files.get(jobs[0].filename)).toBe(retained)
    expect(session.files.has(jobs[1].filename)).toBe(false)
    expect(session.items[1].state).toBe('failed')
    expect(saveBlob).not.toHaveBeenCalled()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      jobs[0].url,
      jobs[1].url,
      buildDownloadUrl(jobs[1].url, jobs[1].filename),
    ])
    if (proxy) expect(proxy.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    recovered = true
    fetch.mockClear()
    await downloadMediaArchive(jobs, '作品.zip', new AbortController().signal, onProgress, session)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      jobs[1].url,
      buildDownloadUrl(jobs[1].url, jobs[1].filename),
      jobs[2].url,
    ])
    expect(saveBlob).toHaveBeenCalledOnce()
    const bytes = new Uint8Array(await vi.mocked(saveBlob).mock.calls[0][0].arrayBuffer())
    const files = unzipSync(bytes)
    expect(Object.keys(files)).toEqual(jobs.map((job) => job.filename))
    expect(Object.values(files).map((file) => [...file])).toEqual([[1], [2], [3]])
    expect(vi.getTimerCount()).toBe(0)
  },
)

test('the ZIP proxy permits steady transfers beyond two minutes without adding requests', async () => {
  let proxy
  const fetch = vi.fn(async (url, options) => {
    if (url === jobs[0].url) throw new TypeError('CORS')
    proxy = mediaStream(options)
    return proxy.response
  })
  vi.stubGlobal('fetch', fetch)
  const running = downloadMediaArchive(
    [jobs[0]],
    '作品.zip',
    new AbortController().signal,
    () => {},
  )
  await vi.advanceTimersByTimeAsync(0)
  for (let index = 0; index < 7; index++) {
    proxy.source.enqueue(new Uint8Array([index]))
    await vi.advanceTimersByTimeAsync(20000)
    expect(proxy.signal.aborted).toBe(false)
    expect(saveBlob).not.toHaveBeenCalled()
  }
  proxy.source.close()
  await running
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    jobs[0].url,
    buildDownloadUrl(jobs[0].url, jobs[0].filename),
  ])
  expect(saveBlob).toHaveBeenCalledOnce()
  const bytes = new Uint8Array(await vi.mocked(saveBlob).mock.calls[0][0].arrayBuffer())
  expect([...unzipSync(bytes)[jobs[0].filename]]).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['response', 'read'])(
  'cancelling a direct ZIP %s never starts the proxy',
  async (phase) => {
    let signal
    const fetch = vi.fn((_url, options) => {
      signal = options.signal
      if (phase === 'response') return new Promise(() => {})
      const media = mediaStream(options)
      media.source.enqueue(new Uint8Array([99]))
      return Promise.resolve(media.response)
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const session = createBatchSession([jobs[0]])
    const running = downloadMediaArchive(
      [jobs[0]],
      '作品.zip',
      controller.signal,
      () => {},
      session,
    )
    const cancelled = expect(running).rejects.toHaveProperty('name', 'AbortError')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await cancelled
    await vi.advanceTimersByTimeAsync(60000)
    expect(signal.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(jobs[0].url, expect.any(Object))
    expect(session.files.size).toBe(0)
    expect(session.nextIndex).toBe(0)
    expect(saveBlob).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  },
)
