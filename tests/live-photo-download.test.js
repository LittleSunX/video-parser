import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { effectScope } from 'vue'
import { unzipSync } from 'fflate'
import { useVideoPage } from '../frontend/src/composables/useVideoPage'
import { parseVideo } from '../frontend/src/api/video'
import { saveBlob } from '../frontend/src/utils/auto-download'
import { buildLivePhotoFilename, triggerDownload } from '../frontend/src/utils/download'
import { SINGLE_BUFFER_BYTES } from '../frontend/src/utils/download-buffer'
import * as mediaArchive from '../frontend/src/utils/media-archive'

vi.mock('../frontend/src/api/video', () => ({ parseVideo: vi.fn() }))
vi.mock('../frontend/src/utils/auto-download', async (importOriginal) => ({
  ...(await importOriginal()),
  saveBlob: vi.fn(),
}))
vi.mock('../frontend/src/utils/download', async (importOriginal) => ({
  ...(await importOriginal()),
  triggerDownload: vi.fn(),
}))

const scopes = []
const firstLiveUrl = 'https://v.douyinvod.com/live-1.mp4'
const secondLiveUrl = 'https://v.douyinvod.com/live-2.mp4'

function gallery(
  images = [{ url: 'https://p.douyinpic.com/still-1.jpg', livePhotoUrl: firstLiveUrl }],
) {
  return {
    platform: 'douyin',
    mediaType: 'image',
    videoId: '1234567890123456789',
    sourceUrl: 'https://www.douyin.com/note/1234567890123456789',
    title: '实况作品',
    author: '作者',
    cover: 'https://p.douyinpic.com/cover.jpg',
    musicUrl: 'https://sf.douyinstatic.com/music.mp3',
    musicTitle: '背景音乐',
    images,
    imagesComplete: false,
    parseStatus: 'unverified',
    parseReason: 'exhausted',
  }
}

function page(result = gallery()) {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  const scope = effectScope()
  scopes.push(scope)
  const app = scope.run(useVideoPage)
  app.video.value = result
  return app
}

function mediaStream(options, length) {
  let source
  const response = new Response(
    new ReadableStream({
      start(controller) {
        source = controller
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason), {
          once: true,
        })
      },
    }),
    {
      headers: {
        'Content-Type': 'video/mp4',
        ...(length ? { 'Content-Length': String(length) } : {}),
      },
    },
  )
  return { source, response, signal: options.signal }
}

beforeEach(() => {
  vi.mocked(saveBlob).mockReset().mockReturnValue('blob:live-photo')
  vi.mocked(triggerDownload)
    .mockReset()
    .mockImplementation(() => vi.fn())
  vi.mocked(parseVideo).mockReset().mockResolvedValue(gallery())
})

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([true, false])(
  'a live MP4 streams directly and can be saved again without another GET (known length=%s)',
  async (knownLength) => {
    const parsed = gallery([
      { url: 'https://p.douyinpic.com/still-1.jpg', livePhotoUrl: firstLiveUrl },
      { url: 'https://p.douyinpic.com/still-2.jpg', livePhotoUrl: secondLiveUrl },
    ])
    let live
    const fetch = vi.fn(async (_url, options) => {
      live = mediaStream(options, knownLength ? 1024 * 1024 : undefined)
      return live.response
    })
    vi.stubGlobal('fetch', fetch)
    const pack = vi.spyOn(mediaArchive, 'createMediaArchive')
    const app = page(parsed)
    const warning = app.parseWarning.value
    const running = app.handleDownloadLivePhoto(1)
    await app.handleDownloadLivePhoto(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0][0]).toBe(secondLiveUrl)
    expect(fetch.mock.calls[0][1]).toMatchObject({
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    expect(app.videoDownloading.value).toBe(true)
    expect(app.bufferBusy.value).toBe(true)
    live.source.enqueue(new Uint8Array(512 * 1024).fill(1))
    await vi.waitFor(() =>
      expect(app.downloadStatus.value).toBe(knownLength ? '正在下载 50%' : '已接收 0.5 MB'),
    )
    expect(saveBlob).not.toHaveBeenCalled()
    live.source.enqueue(new Uint8Array(512 * 1024).fill(2))
    live.source.close()
    await running
    expect(app.downloadState.value).toBe('handed-off')
    expect(app.videoDownloading.value).toBe(false)
    expect(app.bufferBusy.value).toBe(false)
    expect(app.canSaveVideoAgain.value).toBe(true)
    expect(app.video.value.videoUrl).toBeUndefined()
    expect(saveBlob).toHaveBeenCalledOnce()
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]
    expect(filename).toBe(buildLivePhotoFilename(parsed, 1))
    expect(filename).toMatch(/实况_02\.mp4$/)
    expect(blob.type).toBe('video/mp4')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes.byteLength).toBe(1024 * 1024)
    expect(bytes[0]).toBe(1)
    expect(bytes[bytes.length - 1]).toBe(2)
    app.saveVideoAgain()
    expect(saveBlob).toHaveBeenCalledTimes(2)
    expect(vi.mocked(saveBlob).mock.calls[1]).toEqual([
      blob,
      filename,
      { objectUrl: 'blob:live-photo', retain: true },
    ])
    expect(fetch).toHaveBeenCalledOnce()
    expect(triggerDownload).not.toHaveBeenCalled()
    expect(pack).not.toHaveBeenCalled()
    expect(app.video.value).toEqual(parsed)
    expect(app.parseWarning.value).toBe(warning)
  },
)

test.each([
  ['CORS rejection', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['HTTP 403', () => Promise.resolve(new Response('forbidden', { status: 403 }))],
  [
    'oversized MP4',
    () =>
      Promise.resolve(
        new Response('large', {
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(SINGLE_BUFFER_BYTES + 1),
          },
        }),
      ),
  ],
])(
  'a live %s starts one native Worker fallback without saving partial content',
  async (_reason, response) => {
    const fetch = vi.fn(response)
    vi.stubGlobal('fetch', fetch)
    const pack = vi.spyOn(mediaArchive, 'createMediaArchive')
    const parsed = gallery()
    const app = page(parsed)
    await app.handleDownloadLivePhoto(0)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(firstLiveUrl, expect.any(Object))
    expect(triggerDownload).toHaveBeenCalledOnce()
    const [url, filename, onError] = vi.mocked(triggerDownload).mock.calls[0]
    expect(url).toBe(firstLiveUrl)
    expect(filename).toBe(buildLivePhotoFilename(parsed, 0))
    expect(app.downloadState.value).toBe('fallback')
    expect(app.videoDownloading.value).toBe(false)
    expect(app.bufferBusy.value).toBe(false)
    expect(app.canSaveVideoAgain.value).toBe(false)
    expect(saveBlob).not.toHaveBeenCalled()
    expect(pack).not.toHaveBeenCalled()
    onError({ code: 'MEDIA_UNAVAILABLE', message: '链接已失效，请重新解析' })
    expect(app.downloadState.value).toBe('failed')
    expect(app.downloadNeedsReparse.value).toBe(true)
  },
)

test('a live transfer shares the buffer lock and cancelling it releases the lock without fallback', async () => {
  const parsed = gallery([
    { url: 'https://p.douyinpic.com/still-1.jpg', livePhotoUrl: firstLiveUrl },
    { url: 'https://p.douyinpic.com/still-2.jpg', livePhotoUrl: secondLiveUrl },
  ])
  let live
  const fetch = vi.fn(async (url, options) => {
    if (url === parsed.musicUrl)
      return new Response('music', { headers: { 'Content-Type': 'audio/mpeg' } })
    live = mediaStream(options)
    return live.response
  })
  vi.stubGlobal('fetch', fetch)
  const app = page(parsed)
  const running = app.handleDownloadLivePhoto(0)
  live.source.enqueue(new Uint8Array([1, 2]))
  await vi.waitFor(() => expect(app.downloadStatus.value).toContain('已接收'))
  await app.musicDownload.start()
  await app.coverDownload.start()
  await app.handleDownloadAllOriginals()
  app.handleDownloadImage(0)
  expect(fetch).toHaveBeenCalledOnce()
  expect(triggerDownload).not.toHaveBeenCalled()
  expect(app.bufferBusy.value).toBe(true)
  app.cancelVideoDownload()
  await running
  expect(live.signal.aborted).toBe(true)
  expect(app.downloadState.value).toBe('cancelled')
  expect(app.videoDownloading.value).toBe(false)
  expect(app.bufferBusy.value).toBe(false)
  expect(app.canSaveVideoAgain.value).toBe(false)
  expect(saveBlob).not.toHaveBeenCalled()
  expect(triggerDownload).not.toHaveBeenCalled()
  fetch.mockResolvedValueOnce(new Response('live', { headers: { 'Content-Type': 'video/mp4' } }))
  await app.handleDownloadLivePhoto(0)
  expect(app.canSaveVideoAgain.value).toBe(true)
  await app.musicDownload.start()
  expect(app.canSaveVideoAgain.value).toBe(false)
  expect(app.musicDownload.canSaveAgain).toBe(true)
  const saved = vi.mocked(saveBlob).mock.calls.length
  app.saveVideoAgain()
  expect(saveBlob).toHaveBeenCalledTimes(saved)
  expect(fetch).toHaveBeenCalledTimes(3)
})

test('clearing a live transfer prevents old bytes from saving over a new result', async () => {
  let old
  const fetch = vi
    .fn()
    .mockImplementationOnce(async (_url, options) => {
      old = mediaStream(options)
      return old.response
    })
    .mockResolvedValueOnce(new Response('new live', { headers: { 'Content-Type': 'video/mp4' } }))
  vi.stubGlobal('fetch', fetch)
  const app = page()
  const running = app.handleDownloadLivePhoto(0)
  old.source.enqueue(new Uint8Array([1, 2]))
  await vi.waitFor(() => expect(app.downloadStatus.value).toContain('已接收'))
  app.handleClear()
  expect(old.signal.aborted).toBe(true)
  expect(app.video.value).toBeNull()
  expect(app.downloadStatus.value).toBe('')
  app.video.value = gallery([{ url: '', livePhotoUrl: secondLiveUrl }])
  await app.handleDownloadLivePhoto(0)
  await running
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1][0]).toBe(secondLiveUrl)
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(await vi.mocked(saveBlob).mock.calls[0][0].text()).toBe('new live')
  expect(app.downloadState.value).toBe('handed-off')
  expect(triggerDownload).not.toHaveBeenCalled()
})

test.each([false, true])(
  'retrying live direct download keeps the old native transfer and ignores stale errors (old error=%s)',
  async (oldError) => {
    let live
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(async (_url, options) => {
        live = mediaStream(options, 4)
        return live.response
      })
    vi.stubGlobal('fetch', fetch)
    const app = page()
    await app.handleDownloadLivePhoto(0)
    expect(app.downloadState.value).toBe('fallback')
    expect(triggerDownload).toHaveBeenCalledOnce()
    const onError = vi.mocked(triggerDownload).mock.calls[0][2]
    const dispose = vi.mocked(triggerDownload).mock.results[0].value
    const running = app.handleDownloadLivePhoto(0)
    expect(app.downloadState.value).toBe('receiving')
    expect(dispose).not.toHaveBeenCalled()
    live.source.enqueue(new Uint8Array([7, 8]))
    await vi.waitFor(() => expect(app.downloadStatus.value).toBe('正在下载 50%'))
    if (oldError) onError({ code: 'MEDIA_UNAVAILABLE', message: '旧代理下载失败' })
    expect(app.downloadState.value).toBe('receiving')
    expect(app.downloadStatus.value).toBe('正在下载 50%')
    expect(app.downloadNeedsReparse.value).toBe(false)
    expect(app.videoDownloading.value).toBe(true)
    expect(dispose).not.toHaveBeenCalled()
    live.source.enqueue(new Uint8Array([9, 10]))
    live.source.close()
    await running
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(triggerDownload).toHaveBeenCalledOnce()
    expect(saveBlob).toHaveBeenCalledOnce()
    expect([...new Uint8Array(await vi.mocked(saveBlob).mock.calls[0][0].arrayBuffer())]).toEqual([
      7, 8, 9, 10,
    ])
    expect(app.downloadState.value).toBe('handed-off')
    expect(app.canSaveVideoAgain.value).toBe(true)
    if (oldError) onError({ code: 'MEDIA_UNAVAILABLE', message: '迟到的旧错误' })
    expect(app.downloadState.value).toBe('handed-off')
    expect(app.downloadNeedsReparse.value).toBe(false)
    expect(dispose).not.toHaveBeenCalled()
    app.handleClear()
    // 已报错的原生下载由 triggerDownload 自行清理；仍挂起的框架在清空时释放。
    expect(dispose).toHaveBeenCalledTimes(oldError ? 0 : 1)
    expect(app.canSaveVideoAgain.value).toBe(false)
    expect(app.downloadStatus.value).toBe('')
  },
)

test('a refused live file save retains the complete MP4 for a user click without refetching', async () => {
  const fetch = vi.fn(
    async () => new Response('live', { headers: { 'Content-Type': 'video/mp4' } }),
  )
  vi.stubGlobal('fetch', fetch)
  vi.mocked(saveBlob).mockImplementationOnce(() => {
    throw new Error('browser refused')
  })
  const app = page()
  await app.handleDownloadLivePhoto(0)
  expect(app.downloadState.value).toBe('failed')
  expect(app.canSaveVideoAgain.value).toBe(true)
  expect(triggerDownload).not.toHaveBeenCalled()
  app.saveVideoAgain()
  expect(app.downloadState.value).toBe('handed-off')
  expect(saveBlob).toHaveBeenCalledTimes(2)
  expect(vi.mocked(saveBlob).mock.calls[1][0]).toBe(vi.mocked(saveBlob).mock.calls[0][0])
  expect(fetch).toHaveBeenCalledOnce()
})

test('the single preferred live action waits for the same MP4 transfer and never creates a ZIP', async () => {
  let live
  const fetch = vi.fn(async (_url, options) => {
    live = mediaStream(options)
    return live.response
  })
  vi.stubGlobal('fetch', fetch)
  const pack = vi.spyOn(mediaArchive, 'createMediaArchive')
  const app = page()
  let finished = false
  const running = app.handleDownloadAllPreferred().then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(app.videoDownloading.value).toBe(true)
  expect(app.batchDownloading.value).toBe(false)
  live.source.enqueue(new Uint8Array([3, 4]))
  live.source.close()
  await running
  expect(finished).toBe(true)
  expect(app.downloadState.value).toBe('handed-off')
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(vi.mocked(saveBlob).mock.calls[0][1]).toMatch(/实况_01\.mp4$/)
  expect(app.batchItems.value).toEqual([])
  expect(app.batchPart.value).toBeNull()
  expect(app.canSaveBatchAgain.value).toBe(false)
  expect(pack).not.toHaveBeenCalled()
  expect(triggerDownload).not.toHaveBeenCalled()
})

test('missing live URLs do not request a file or consume the buffer', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const app = page(gallery([{ url: 'https://p.douyinpic.com/still.jpg' }]))
  await app.handleDownloadLivePhoto(0)
  await app.handleDownloadLivePhoto(1)
  expect(fetch).not.toHaveBeenCalled()
  expect(triggerDownload).not.toHaveBeenCalled()
  expect(saveBlob).not.toHaveBeenCalled()
  expect(app.bufferBusy.value).toBe(false)
})

test('multiple preferred live files still save one ZIP with each complete MP4', async () => {
  const parsed = gallery([
    { url: 'https://p.douyinpic.com/still-1.jpg', livePhotoUrl: firstLiveUrl },
    { url: 'https://p.douyinpic.com/still-2.jpg', livePhotoUrl: secondLiveUrl },
  ])
  const fetch = vi.fn(
    async (url) =>
      new Response(new Uint8Array([url === firstLiveUrl ? 1 : 2]), {
        headers: { 'Content-Type': 'video/mp4' },
      }),
  )
  vi.stubGlobal('fetch', fetch)
  const app = page(parsed)
  await app.handleDownloadAllPreferred()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([firstLiveUrl, secondLiveUrl])
  expect(app.videoDownloading.value).toBe(false)
  expect(app.batchDownloading.value).toBe(false)
  expect(saveBlob).toHaveBeenCalledOnce()
  const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]
  expect(filename).toMatch(/\.zip$/)
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  expect(Object.keys(files)).toEqual([
    buildLivePhotoFilename(parsed, 0),
    buildLivePhotoFilename(parsed, 1),
  ])
  expect(Object.values(files).map((bytes) => [...bytes])).toEqual([[1], [2]])
  expect(triggerDownload).not.toHaveBeenCalled()
})
