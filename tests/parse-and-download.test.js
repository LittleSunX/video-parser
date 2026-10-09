import * as batchArchive from '../frontend/src/utils/batch-download'
import { unzipSync } from 'fflate'
import { test, afterEach, vi } from 'vitest'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { useVideoPage } from '../frontend/src/composables/useVideoPage'
import { parseVideo as apiParseVideo } from '../frontend/src/api/video'
import { triggerDownload } from '../frontend/src/utils/download'
import * as mediaArchive from '../frontend/src/utils/media-archive'
import { PREPARED_DOWNLOAD_TTL_MS } from '../frontend/src/utils/prepared-download'

vi.mock('../frontend/src/api/video', () => ({ parseVideo: vi.fn() }))
vi.mock('../frontend/src/utils/download', () => ({
  triggerDownload: vi.fn(),
  buildDownloadUrl: (url) => 'https://proxy/?url=' + encodeURIComponent(url),
  buildVideoFilename: () => 'video.mp4',
  buildImageFilename: (_video, index) => index + '.jpg',
  buildLivePhotoFilename: (_video, index) => index + '.mp4',
  buildCoverFilename: () => 'cover.jpg',
  buildMusicFilename: () => 'music.mp3',
}))
import { DouyinParser } from '../worker/src/parsers/douyin.ts'
import { parseVideo } from '../worker/src/services/parse-service.ts'
import { formatDuration } from '../frontend/src/utils/duration.ts'
const originalFetch = global.fetch
const originalTimeout = global.setTimeout
const originalWindow = global.window
const originalDocument = global.document
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
  global.fetch = originalFetch
  global.setTimeout = originalTimeout
  global.window = originalWindow
  global.document = originalDocument
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})
const id = '7685989846276676267'
const url = 'https://www.douyin.com/video/' + id
const cleanImage = { watermark_free_download_url_list: ['https://p.douyinpic.com/image.jpg'] }
const itemResponse = (images) => Response.json({ aweme_detail: { aweme_id: id, images } })
function hangUntilAborted(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('ordinary clean photo returns after the first successful strategy', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    return itemResponse([cleanImage])
  }
  const result = await new DouyinParser().parse(url)
  assert.equal(result.mediaType, 'image')
  assert.equal(result.images.length, 1)
  assert.equal(calls, 1)
})

test('three complete live tracks still seek clean images from fallback', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    return itemResponse(
      [1, 2, 3].map((index) => ({
        ...(calls === 1
          ? { url_list: ['https://p.douyinpic.com/' + index + '.jpg'] }
          : { watermark_free_download_url_list: ['https://p.douyinpic.com/' + index + '.jpg'] }),
        video: { play_addr: { uri: 'live-' + index } },
      })),
    )
  }
  const result = await new DouyinParser().parse(url)
  assert.equal(calls, 2)
  assert.equal(result.images.length, 3)
  assert.equal(
    result.images.every((image) => image.livePhotoUrl && image.watermarkFree),
    true,
  )
})

test('a complete live entry does not hide an unparsed entry', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    const live = (index) => ({
      watermark_free_download_url_list: ['https://p.douyinpic.com/' + index + '.jpg'],
      video: { play_addr: { uri: 'live-' + index } },
    })
    return itemResponse([live(1), calls === 1 ? {} : live(2)])
  }
  const result = await new DouyinParser().parse(url)
  assert.equal(calls, 2)
  assert.equal(result.images.length, 2)
})

test('known but missing live track continues fallback', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    return itemResponse([
      { ...cleanImage, video: calls === 1 ? {} : { play_addr: { uri: 'live-video-id' } } },
    ])
  }
  const result = await new DouyinParser().parse(url)
  assert.equal(calls, 2)
  assert.match(result.images[0].livePhotoUrl, /video_id=live-video-id/)
})

test('client cancellation stops retries and returns the cancellation error', async () => {
  const controller = new AbortController()
  let calls = 0
  global.fetch = async (_url, options) => {
    calls++
    controller.abort()
    return hangUntilAborted(options.signal)
  }
  await assert.rejects(parseVideo(url, controller.signal), {
    code: 'REQUEST_CANCELLED',
    status: 499,
  })
  assert.equal(calls, 1)
})

test('shared deadline aborts a stalled upstream and returns a timeout', async () => {
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 30000 ? 15 : ms, ...args)
  let calls = 0
  global.fetch = (_url, options) => {
    calls++
    return hangUntilAborted(options.signal)
  }
  await assert.rejects(parseVideo(url), { code: 'PARSE_TIMEOUT', status: 504 })
  assert.equal(calls, 1)
})

test('short-link expansion is included in the same total deadline', async () => {
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 30000 ? 15 : ms, ...args)
  global.fetch = (_url, options) => hangUntilAborted(options.signal)
  await assert.rejects(parseVideo('https://v.douyin.com/example/'), { code: 'PARSE_TIMEOUT' })
})

test('timeout preserves already obtained usable images', async () => {
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 30000 ? 15 : ms, ...args)
  let calls = 0
  global.fetch = async (_url, options) => {
    calls++
    if (calls === 1) return itemResponse([{ url_list: ['https://p.douyinpic.com/image.jpg'] }])
    return hangUntilAborted(options.signal)
  }
  const result = await parseVideo(url)
  assert.equal(result.images.length, 1)
  assert.equal(calls, 2)
})

test('milliseconds are consistent for short and long videos', async () => {
  assert.equal(formatDuration(8000), '00:08')
  assert.equal(formatDuration(10000), '00:10')
  assert.equal(formatDuration(65000), '01:05')
  assert.equal(formatDuration(undefined), '')
  assert.equal(formatDuration(Infinity), '')
  assert.equal(formatDuration(-100), '')
  global.fetch = async () =>
    Response.json({
      aweme_detail: {
        aweme_id: id,
        duration: 0,
        video: { duration: 8000, play_addr: { url_list: ['https://v.douyinvod.com/video.mp4'] } },
      },
    })
  const result = await new DouyinParser().parse(url)
  assert.equal(result.duration, 8000)
})

// Exercise the same composables used by App.vue in a real Vue effect scope.
function createApp(parseMock = async () => ({})) {
  vi.mocked(apiParseVideo).mockImplementation(parseMock)
  const downloads = []
  vi.mocked(triggerDownload).mockImplementation((url, filename) =>
    downloads.push({ url, filename }),
  )
  const listeners = new Map()
  global.window = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener)
    },
  }
  const scope = effectScope()
  const app = scope.run(() => useVideoPage())
  cleanups.push(() => scope.stop())
  return {
    app,
    downloads,
    pagehide: () => {
      for (const listener of [...(listeners.get('pagehide') ?? [])]) listener()
    },
    dispose: () => scope.stop(),
  }
}

test('batch saves all three dynamic videos in one archive and shares a lock', async () => {
  const { clicks, blobs } = mockBrowserSave()
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    return new Response(new Uint8Array([Number(url.slice(-1))]), {
      headers: { 'Content-Type': url.includes('live') ? 'video/mp4' : 'image/jpeg' },
    })
  }
  const { app, downloads } = createApp()
  app.video.value = {
    images: [1, 2, 3].map((i) => ({
      url: 'https://image/' + i,
      livePhotoUrl: 'https://live/' + i,
    })),
  }
  const first = app.handleDownloadAllPreferred()
  assert.equal(app.batchDownloading.value, true)
  await app.handleDownloadAllOriginals()
  await first
  assert.deepEqual(requests, ['https://live/1', 'https://live/2', 'https://live/3'])
  assert.equal(downloads.length, 0)
  assert.equal(clicks.length, 1)
  const files = unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))
  assert.deepEqual(Object.keys(files), ['0.mp4', '1.mp4', '2.mp4'])
  assert.deepEqual(
    Object.values(files).map((v) => [...v]),
    [[1], [2], [3]],
  )
  assert.match(app.batchProgress.value, /3 \/ 3/)
  requests.length = 0
  app.video.value.images[1].url = ''
  await app.handleDownloadAllOriginals()
  assert.deepEqual(requests, ['https://image/1', 'https://image/3'])
  assert.equal(app.batchDownloading.value, false)
})

test('clearing a result aborts batch fetching without saving a partial archive', async () => {
  const { clicks } = mockBrowserSave()
  global.fetch = (_url, options) => hangUntilAborted(options.signal)
  const { app } = createApp()
  app.video.value = { images: [{ url: 'https://image/1' }, { url: 'https://image/2' }] }
  const running = app.handleDownloadAllOriginals()
  app.handleClear()
  await running
  assert.equal(clicks.length, 0)
  assert.equal(app.batchDownloading.value, false)
})

test('batch falls back to proxy and never saves an incomplete archive on failure', async () => {
  const { clicks, blobs } = mockBrowserSave()
  const { app } = createApp()
  app.video.value = { images: [{ url: 'https://image/1' }] }
  global.fetch = async (url) => {
    if (!url.startsWith('https://proxy')) throw new TypeError('CORS')
    return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })
  }
  await app.handleDownloadAllOriginals()
  assert.equal(clicks.length, 1)
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))), ['0.jpg'])
  app.video.value.images.push({ url: 'https://image/2' })
  global.fetch = async (url) => {
    if (url.includes('2')) throw new Error('offline')
    return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })
  }
  await app.handleDownloadAllOriginals()
  assert.equal(clicks.length, 1)
  assert.match(app.batchProgress.value, /第 2 \/ 2 项获取失败/)
})

test('mixed batches retain still images and reject oversized responses without saving', async () => {
  const { clicks, blobs } = mockBrowserSave()
  const { app } = createApp()
  app.video.value = {
    images: [{ url: '', livePhotoUrl: 'https://live/1' }, { url: 'https://image/2' }],
  }
  global.fetch = async (url) =>
    new Response('media', {
      headers: { 'Content-Type': url.includes('live') ? 'video/mp4' : 'image/jpeg' },
    })
  await app.handleDownloadAllPreferred()
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))), [
    '0.mp4',
    '1.jpg',
  ])
  global.fetch = async () =>
    new Response('large', {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(129 * 1024 * 1024) },
    })
  await app.handleDownloadAllPreferred()
  assert.equal(clicks.length, 1)
  assert.match(app.batchProgress.value, /32 MB/)
  assert.equal(app.batchDownloading.value, false)
})

test('cancelled parse cannot overwrite a newer parse result', async () => {
  const requests = []
  const { app } = createApp(
    (_input, signal) => new Promise((resolve) => requests.push({ signal, resolve })),
  )
  app.input.value = url
  const first = app.handleParse()
  app.cancelParse()
  assert.equal(requests[0].signal.aborted, true)
  const second = app.handleParse()
  requests[1].resolve({ title: 'new result', mediaType: 'video' })
  await second
  requests[0].resolve({ title: 'old result', mediaType: 'video' })
  await first
  assert.equal(app.video.value.title, 'new result')
  assert.equal(app.loading.value, false)
})

function mockBrowserSave() {
  const clicks = []
  const blobs = []
  const revoked = []
  global.document = {
    body: { appendChild() {} },
    createElement() {
      return {
        click() {
          clicks.push({ href: this.href, download: this.download, target: this.target })
        },
        remove() {},
      }
    },
  }
  URL.createObjectURL = (blob) => {
    blobs.push(blob)
    return 'blob:test-video' + (blobs.length === 1 ? '' : '-' + blobs.length)
  }
  URL.revokeObjectURL = (url) => revoked.push(url)
  return { clicks, blobs, revoked }
}

test('video download saves a CDN response as a blob without opening a tab', async () => {
  const { clicks, blobs } = mockBrowserSave()
  global.fetch = async (_url, options) => {
    assert.equal(options.mode, 'cors')
    assert.equal(options.credentials, 'omit')
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '3' },
    })
  }
  const { app, downloads } = createApp()
  app.video.value = { mediaType: 'video', videoUrl: 'https://cdn/video.mp4' }
  await app.handleDownloadVideo()
  assert.equal(downloads.length, 0)
  assert.deepEqual(clicks, [{ href: 'blob:test-video', download: 'video.mp4', target: undefined }])
  assert.equal(blobs[0].size, 3)
  assert.match(app.downloadStatus.value, /已请求浏览器保存/)
  assert.equal(app.downloadState.value, 'handed-off')
  assert.match(app.notice.value, /浏览器保存/)
  assert.equal(app.videoDownloading.value, false)
})

test('CORS failure automatically falls back to the existing download endpoint', async () => {
  global.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
  const { app, downloads } = createApp()
  app.video.value = { mediaType: 'video', videoUrl: 'https://cdn/video.mp4' }
  await app.handleDownloadVideo()
  assert.equal(downloads.length, 1)
  assert.match(app.downloadStatus.value, /已切换到备用下载/)
  assert.equal(app.downloadState.value, 'fallback')
})

test('cancelling a direct download never launches a fallback download', async () => {
  global.fetch = (_url, options) => hangUntilAborted(options.signal)
  const { app, downloads } = createApp()
  app.video.value = { mediaType: 'video', videoUrl: 'https://cdn/video.mp4' }
  const running = app.handleDownloadVideo()
  await app.handleDownloadVideo() // duplicate click is ignored
  app.cancelVideoDownload()
  await running
  assert.equal(downloads.length, 0)
  assert.equal(app.videoDownloading.value, false)
  assert.equal(app.downloadStatus.value, '已取消下载')
})

test('large files bypass blob buffering and use the native download path', async () => {
  global.fetch = async () =>
    new Response('large file', {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(129 * 1024 * 1024),
      },
    })
  const { app, downloads } = createApp()
  app.video.value = { mediaType: 'video', videoUrl: 'https://cdn/video.mp4' }
  await app.handleDownloadVideo()
  assert.equal(downloads.length, 1)
})

test('HTML error pages are never saved as video files', async () => {
  const { clicks } = mockBrowserSave()
  global.fetch = async () =>
    new Response('<html>denied</html>', { headers: { 'Content-Type': 'text/html' } })
  const { app, downloads } = createApp()
  app.video.value = { mediaType: 'video', videoUrl: 'https://cdn/video.mp4' }
  await app.handleDownloadVideo()
  assert.equal(clicks.length, 0)
  assert.equal(downloads.length, 1)
})

test('frontend parse timeout releases loading state and allows retry', async () => {
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 35000 ? 10 : ms, ...args)
  const { app } = createApp((_input, signal) => hangUntilAborted(signal))
  app.input.value = url
  await app.handleParse()
  assert.equal(app.loading.value, false)
  assert.match(app.errorMessage.value, /解析超时/)
  assert.equal(app.canSubmit.value, true)
})

test('partial parse results remain available with a persistent warning until a complete retry', async () => {
  const partial = {
    mediaType: 'image',
    images: [{ url: 'https://image/1' }],
    parseStatus: 'unverified',
    parseReason: 'timeout',
  }
  const { app } = createApp(async () => partial)
  app.input.value = url
  await app.handleParse()
  assert.equal(app.video.value.images.length, 1)
  assert.match(app.parseWarning.value, /超时/)
  assert.match(app.notice.value, /完整性尚未确认/)
  vi.mocked(apiParseVideo).mockResolvedValue({
    ...partial,
    parseStatus: 'complete',
    parseReason: 'complete',
  })
  await app.handleParse()
  assert.equal(app.parseWarning.value, '')
  assert.match(app.notice.value, /图文解析成功/)
})

test.each(['exhausted', 'timeout'])(
  'complete images with unknown watermark show a neutral notice after %s',
  async (parseReason) => {
    const parsed = {
      mediaType: 'image',
      title: '排名图文',
      author: '天成（王者万象棋）',
      musicUrl: 'https://music/example.mp3',
      images: [{ url: 'https://image/1', watermarkFree: false }],
      imagesComplete: true,
      parseStatus: 'unverified',
      parseReason,
    }
    const { app } = createApp(async () => parsed)
    app.input.value = url
    await app.handleParse()
    assert.equal(app.parseWarning.value, '')
    assert.match(app.imageQualityNotice.value, /图片已获取，无水印状态未确认/)
    assert.equal(app.notice.value, '图文解析成功')
    assert.equal(app.video.value.author, parsed.author)
    assert.equal(app.video.value.musicUrl, parsed.musicUrl)
    assert.equal(app.video.value.images[0].watermarkFree, false)
    app.handleClear()
    assert.equal(app.imageQualityNotice.value, '')
  },
)

test.each([
  ['unverified', 'exhausted'],
  ['unverified', 'timeout'],
  ['complete', 'complete'],
])(
  'known missing image resources keep a warning with %s / %s',
  async (parseStatus, parseReason) => {
    const { app } = createApp(async () => ({
      mediaType: 'image',
      images: [{ url: 'https://image/1', watermarkFree: true }],
      imagesComplete: false,
      parseStatus,
      parseReason,
    }))
    app.input.value = url
    await app.handleParse()
    assert.notEqual(app.parseWarning.value, '')
    assert.match(app.notice.value, /完整性尚未确认/)
    assert.equal(app.imageQualityNotice.value, '')
  },
)

test('a complete live album retains its dynamic tracks without a completeness warning', async () => {
  const images = [1, 2, 3].map((index) => ({
    url: 'https://images/' + index,
    livePhotoUrl: 'https://live/' + index,
    watermarkFree: false,
  }))
  const { app } = createApp(async () => ({
    mediaType: 'image',
    images,
    imagesComplete: true,
    parseStatus: 'unverified',
    parseReason: 'exhausted',
  }))
  app.input.value = url
  await app.handleParse()
  assert.equal(app.livePhotoCount.value, 3)
  assert.deepEqual(app.video.value.images, images)
  assert.equal(app.parseWarning.value, '')
  assert.match(app.imageQualityNotice.value, /无水印状态未确认/)
  assert.equal(app.notice.value, '实况图文解析成功')
  app.video.value.images.forEach((image) => (image.watermarkFree = true))
  assert.equal(app.imageQualityNotice.value, '')
})

test('native download failure offers reparse and stale failures cannot replace newer state', () => {
  const { app } = createApp()
  const callbacks = []
  const dispose = vi.fn()
  vi.mocked(triggerDownload).mockImplementation((_url, _filename, onError) => {
    callbacks.push(onError)
    return dispose
  })
  app.video.value = { videoUrl: 'https://cdn/video.mp4' }
  app.handleProxyDownloadVideo()
  callbacks[0]({ code: 'MEDIA_UNAVAILABLE', message: '资源失效，请重新解析' })
  assert.equal(app.downloadState.value, 'failed')
  assert.equal(app.downloadNeedsReparse.value, true)
  app.handleProxyDownloadVideo()
  callbacks[0]({ code: 'MEDIA_UNAVAILABLE', message: '旧错误' })
  assert.equal(app.downloadState.value, 'fallback')
  callbacks[1]({ code: 'RATE_LIMITED', message: '等待 60 秒' })
  assert.equal(app.downloadNeedsReparse.value, false)
  assert.equal(app.downloadStatus.value, '等待 60 秒')
  app.handleProxyDownloadVideo()
  app.handleClear()
  assert.equal(dispose.mock.calls.length, 1)
  callbacks[2]({ code: 'MEDIA_UNAVAILABLE', message: '清空后的旧错误' })
  assert.equal(app.downloadStatus.value, '')
})

test('a partial image list does not prevent fallback from recovering missing images', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    return itemResponse(
      calls === 1
        ? [cleanImage, {}]
        : [
            cleanImage,
            {
              ...cleanImage,
              watermark_free_download_url_list: ['https://p.douyinpic.com/second.jpg'],
            },
          ],
    )
  }
  const result = await new DouyinParser().parse(url)
  assert.equal(calls, 2)
  assert.equal(result.images.length, 2)
})

test('batch retry reuses successful files and only fetches unfinished items', async () => {
  const { clicks, blobs } = mockBrowserSave()
  const { app } = createApp()
  app.video.value = { images: [1, 2, 3].map((i) => ({ url: 'https://image/' + i })) }
  const requests = []
  let broken = true
  global.fetch = async (url) => {
    requests.push(url)
    if (url.endsWith('2') && broken) throw new TypeError('offline')
    return new Response(new Uint8Array([Number(url.slice(-1))]), {
      headers: { 'Content-Type': 'image/jpeg' },
    })
  }
  await app.handleDownloadAllOriginals()
  assert.equal(clicks.length, 0)
  assert.equal(app.batchCanRetry.value, true)
  assert.equal(app.batchHasCache.value, true)
  assert.deepEqual(
    app.batchItems.value.map((item) => item.state),
    ['ready', 'failed', 'pending'],
  )
  requests.length = 0
  broken = false
  await app.retryBatchDownload()
  assert.deepEqual(requests, ['https://image/2', 'https://image/3'])
  assert.equal(clicks.length, 1)
  const files = unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))
  assert.deepEqual(
    Object.values(files).map((bytes) => [...bytes]),
    [[1], [2], [3]],
  )
  assert.equal(app.batchHasCache.value, false)
  assert.equal(app.batchCanRetry.value, false)
})

test('discarding a failed batch clears cached files before the next attempt', async () => {
  mockBrowserSave()
  const { app } = createApp()
  app.video.value = { images: [1, 2].map((i) => ({ url: 'https://image/' + i })) }
  let requests = []
  global.fetch = async (url) => {
    requests.push(url)
    if (url.endsWith('2')) throw new TypeError('offline')
    return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })
  }
  await app.handleDownloadAllOriginals()
  assert.equal(app.batchHasCache.value, true)
  app.stopBatchDownload()
  assert.equal(app.batchHasCache.value, false)
  assert.equal(app.batchItems.value.length, 0)
  requests = []
  await app.handleDownloadAllOriginals()
  assert.equal(requests[0], 'https://image/1')
})

test('batch distinguishes expired resources and size limits from retryable network errors', async () => {
  const { clicks } = mockBrowserSave()
  const { app } = createApp()
  app.video.value = { images: [{ url: 'https://image/1' }] }
  global.fetch = async () => new Response('expired', { status: 403 })
  await app.handleDownloadAllOriginals()
  assert.match(app.batchProgress.value, /重新解析/)
  assert.equal(app.batchCanRetry.value, false)
  let requests = 0
  global.fetch = async () => {
    requests++
    return new Response('large', {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(129 * 1024 * 1024) },
    })
  }
  await app.handleDownloadAllOriginals()
  assert.equal(requests, 1)
  assert.match(app.batchProgress.value, /32 MB/)
  assert.equal(app.batchCanRetry.value, false)
  assert.equal(clicks.length, 0)
})

test('switching batch mode drops cached dynamic files and reparse clears failed state', async () => {
  const { blobs } = mockBrowserSave()
  const { app } = createApp(async () => ({ mediaType: 'image', images: [] }))
  app.video.value = {
    images: [1, 2].map((i) => ({ url: 'https://image/' + i, livePhotoUrl: 'https://live/' + i })),
  }
  let failLive = true
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    if (url.includes('live') && url.endsWith('2') && failLive) throw new TypeError('offline')
    return new Response('media', {
      headers: { 'Content-Type': url.includes('live') ? 'video/mp4' : 'image/jpeg' },
    })
  }
  await app.handleDownloadAllPreferred()
  assert.equal(app.batchHasCache.value, true)
  requests.length = 0
  await app.handleDownloadAllOriginals()
  assert.deepEqual(requests, ['https://image/1', 'https://image/2'])
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))), [
    '0.jpg',
    '1.jpg',
  ])
  await app.handleDownloadAllPreferred()
  assert.equal(app.batchHasCache.value, true)
  failLive = false
  app.input.value = url
  await app.handleParse()
  assert.equal(app.batchHasCache.value, false)
  assert.equal(app.batchCanRetry.value, false)
  assert.equal(app.batchItems.value.length, 0)
})

test('batch UI pauses at each package until save and continue are clicked', async () => {
  const createSession = batchArchive.createBatchSession
  vi.spyOn(batchArchive, 'createBatchSession').mockImplementation((jobs) => createSession(jobs, 6))
  const { clicks, blobs } = mockBrowserSave()
  const { app } = createApp()
  app.video.value = { images: [1, 2].map((i) => ({ url: 'https://image/' + i })) }
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    return new Response(new Uint8Array(6).fill(Number(url.slice(-1))), {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '6' },
    })
  }
  await app.handleDownloadAllOriginals()
  assert.equal(clicks.length, 0)
  assert.equal(app.batchPart.value.number, 1)
  assert.equal(app.batchCanContinue.value, false)
  await app.continueBatchDownload()
  assert.deepEqual(requests, ['https://image/1'])
  app.saveBatchPart()
  assert.equal(clicks.length, 1)
  assert.equal(app.batchPart.value, null)
  assert.equal(app.batchCanContinue.value, true)
  await app.continueBatchDownload()
  assert.equal(app.batchPart.value.number, 2)
  assert.equal(app.batchPart.value.final, true)
  assert.equal(clicks.length, 1)
  app.saveBatchPart()
  assert.equal(clicks.length, 2)
  assert.equal(app.batchCanContinue.value, false)
  assert.match(app.batchProgress.value, /全部分包/)
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blobs[0].arrayBuffer()))), ['0.jpg'])
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blobs[1].arrayBuffer()))), ['1.jpg'])
})

test.each(['video', 'music', 'cover', 'zip'])(
  '%s can be saved again synchronously without a new GET or ZIP',
  async (kind) => {
    const { clicks, blobs } = mockBrowserSave()
    const pack = vi.spyOn(mediaArchive, 'createMediaArchive')
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'Content-Type':
              kind === 'music' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'image/jpeg',
          },
        }),
    )
    global.fetch = fetch
    const { app } = createApp()
    app.video.value = {
      mediaType: kind === 'zip' ? 'image' : 'video',
      videoUrl: 'https://cdn/video.mp4',
      musicUrl: 'https://cdn/music.mp3',
      cover: 'https://cdn/cover.jpg',
      images: [{ url: 'https://cdn/image.jpg' }],
    }
    const start =
      kind === 'video'
        ? app.handleDownloadVideo
        : kind === 'music'
          ? app.musicDownload.start
          : kind === 'cover'
            ? app.coverDownload.start
            : app.handleDownloadAllOriginals
    const again =
      kind === 'video'
        ? app.saveVideoAgain
        : kind === 'music'
          ? app.musicDownload.saveAgain
          : kind === 'cover'
            ? app.coverDownload.saveAgain
            : app.saveBatchAgain
    await start()
    assert.equal(clicks.length, 1)
    again()
    assert.equal(clicks.length, 2)
    assert.equal(clicks[1].href, clicks[0].href)
    assert.equal(clicks[1].download, clicks[0].download)
    assert.equal(blobs.length, 1)
    assert.equal(fetch.mock.calls.length, 1)
    assert.equal(pack.mock.calls.length, kind === 'zip' ? 1 : 0)
  },
)

test.each(['video', 'music', 'cover', 'zip'])(
  'a failed %s browser handoff keeps received bytes for a save click',
  async (kind) => {
    const { clicks } = mockBrowserSave()
    const createElement = global.document.createElement
    let fail = true
    global.document.createElement = () => {
      const anchor = createElement()
      const click = anchor.click
      anchor.click = function () {
        if (fail) {
          fail = false
          throw new Error('browser refused')
        }
        click.call(this)
      }
      return anchor
    }
    const pack = vi.spyOn(mediaArchive, 'createMediaArchive')
    const fetch = vi.fn(
      async () =>
        new Response('media', {
          headers: {
            'Content-Type':
              kind === 'video' ? 'video/mp4' : kind === 'music' ? 'audio/mpeg' : 'image/jpeg',
          },
        }),
    )
    global.fetch = fetch
    const { app, downloads } = createApp()
    app.video.value = {
      mediaType: kind === 'zip' ? 'image' : 'video',
      videoUrl: 'https://cdn/video.mp4',
      musicUrl: 'https://cdn/music.mp3',
      cover: 'https://cdn/cover.jpg',
      images: [{ url: 'https://cdn/image.jpg' }],
    }
    if (kind === 'video') {
      await app.handleDownloadVideo()
      assert.equal(app.canSaveVideoAgain.value, true)
      app.saveVideoAgain()
    } else if (kind === 'music' || kind === 'cover') {
      const download = kind === 'music' ? app.musicDownload : app.coverDownload
      await download.start()
      assert.equal(download.canSaveAgain, true)
      download.saveAgain()
    } else {
      await app.handleDownloadAllOriginals()
      assert.equal(app.batchPart.value.final, true)
      app.saveBatchPart()
    }
    assert.equal(clicks.length, 1)
    assert.equal(fetch.mock.calls.length, 1)
    assert.equal(pack.mock.calls.length, kind === 'zip' ? 1 : 0)
    assert.equal(downloads.length, 0)
  },
)

test('page buffering is mutually exclusive across video, music, cover and ZIP', async () => {
  mockBrowserSave()
  const fetch = vi.fn((_url, options) => hangUntilAborted(options.signal))
  global.fetch = fetch
  const { app } = createApp()
  app.video.value = {
    videoUrl: 'https://cdn/video.mp4',
    musicUrl: 'https://cdn/music.mp3',
    cover: 'https://cdn/cover.jpg',
    images: [{ url: 'https://cdn/image.jpg' }],
  }
  const running = app.handleDownloadVideo()
  assert.equal(app.bufferBusy.value, true)
  await app.musicDownload.start()
  await app.coverDownload.start()
  await app.handleDownloadAllOriginals()
  assert.equal(fetch.mock.calls.length, 1)
  app.cancelVideoDownload()
  await running
  assert.equal(app.bufferBusy.value, false)
  fetch.mockResolvedValueOnce(new Response('music', { headers: { 'Content-Type': 'audio/mpeg' } }))
  await app.musicDownload.start()
  assert.equal(fetch.mock.calls.length, 2)
  assert.equal(app.musicDownload.canSaveAgain, true)
})

test.each(['clear', 'reparse', 'pagehide', 'dispose', 'expiry'])(
  'prepared video is released on %s and cannot be saved again',
  async (action) => {
    vi.useFakeTimers()
    const { clicks, revoked } = mockBrowserSave()
    const fetch = vi.fn(
      async () => new Response('video', { headers: { 'Content-Type': 'video/mp4' } }),
    )
    global.fetch = fetch
    const { app, pagehide, dispose } = createApp()
    app.video.value = { videoUrl: 'https://cdn/video.mp4' }
    await app.handleDownloadVideo()
    assert.equal(app.canSaveVideoAgain.value, true)
    if (action === 'clear') app.handleClear()
    if (action === 'reparse') {
      app.input.value = url
      await app.handleParse()
    }
    if (action === 'pagehide') pagehide()
    if (action === 'dispose') dispose()
    if (action === 'expiry') await vi.advanceTimersByTimeAsync(PREPARED_DOWNLOAD_TTL_MS)
    assert.equal(app.canSaveVideoAgain.value, false)
    app.saveVideoAgain()
    assert.equal(clicks.length, 1)
    assert.deepEqual(revoked, ['blob:test-video'])
    assert.equal(fetch.mock.calls.length, 1)
  },
)

test('starting another task releases the previous saved Blob URL instead of accumulating files', async () => {
  const { blobs, revoked } = mockBrowserSave()
  global.fetch = async (request) =>
    new Response('media', {
      headers: {
        'Content-Type': request.includes('music')
          ? 'audio/mpeg'
          : request.includes('cover')
            ? 'image/jpeg'
            : 'video/mp4',
      },
    })
  const { app } = createApp()
  app.video.value = {
    videoUrl: 'https://cdn/video.mp4',
    musicUrl: 'https://cdn/music.mp3',
    cover: 'https://cdn/cover.jpg',
  }
  await app.handleDownloadVideo()
  await app.coverDownload.start()
  assert.equal(app.canSaveVideoAgain.value, false)
  assert.equal(app.coverDownload.canSaveAgain, true)
  await app.musicDownload.start()
  assert.equal(app.coverDownload.canSaveAgain, false)
  assert.equal(app.musicDownload.canSaveAgain, true)
  assert.equal(blobs.length, 3)
  assert.deepEqual(revoked, ['blob:test-video', 'blob:test-video-2'])
})

test('saved ZIP parts can be saved again before continuing, and expiry does not discard completed progress', async () => {
  vi.useFakeTimers()
  const createSession = batchArchive.createBatchSession
  vi.spyOn(batchArchive, 'createBatchSession').mockImplementation((jobs) => createSession(jobs, 6))
  const { clicks, blobs, revoked } = mockBrowserSave()
  const pack = vi.spyOn(mediaArchive, 'createMediaArchive')
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array(6), {
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '6' },
      }),
  )
  global.fetch = fetch
  const { app } = createApp()
  app.video.value = { images: [1, 2].map((i) => ({ url: 'https://image/' + i })) }
  await app.handleDownloadAllOriginals()
  app.saveBatchPart()
  app.saveBatchAgain()
  assert.equal(clicks.length, 2)
  assert.equal(fetch.mock.calls.length, 1)
  assert.equal(pack.mock.calls.length, 1)
  assert.equal(blobs.length, 1)
  await vi.advanceTimersByTimeAsync(PREPARED_DOWNLOAD_TTL_MS)
  assert.equal(app.canSaveBatchAgain.value, false)
  assert.equal(app.batchCanContinue.value, true)
  assert.deepEqual(revoked, ['blob:test-video'])
  await app.continueBatchDownload()
  assert.equal(app.batchPart.value.number, 2)
  assert.deepEqual(
    fetch.mock.calls.map(([request]) => request),
    ['https://image/1', 'https://image/2'],
  )
  app.saveBatchPart()
  assert.equal(clicks.length, 3)
  assert.equal(pack.mock.calls.length, 2)
})

test('failed batch partial files have a short task lifetime', async () => {
  vi.useFakeTimers()
  mockBrowserSave()
  global.fetch = async (request) => {
    if (request.includes('2')) throw new TypeError('offline')
    return new Response('image', { headers: { 'Content-Type': 'image/jpeg' } })
  }
  const { app } = createApp()
  app.video.value = { images: [1, 2].map((i) => ({ url: 'https://image/' + i })) }
  await app.handleDownloadAllOriginals()
  assert.equal(app.batchHasCache.value, true)
  assert.equal(app.batchCanRetry.value, true)
  await vi.advanceTimersByTimeAsync(PREPARED_DOWNLOAD_TTL_MS)
  assert.equal(app.batchHasCache.value, false)
  assert.equal(app.batchCanRetry.value, false)
  assert.match(app.batchProgress.value, /暂存已到期/)
})
