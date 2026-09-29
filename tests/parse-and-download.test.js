import { unzipSync } from 'fflate'
import { test, afterEach, vi } from 'vitest'
import assert from 'node:assert/strict'
import { effectScope } from 'vue'
import { useVideoPage } from '../frontend/src/composables/useVideoPage'
import { parseVideo as apiParseVideo } from '../frontend/src/api/video'
import { triggerDownload } from '../frontend/src/utils/download'

vi.mock('../frontend/src/api/video', () => ({ parseVideo: vi.fn() }))
vi.mock('../frontend/src/utils/download', () => ({
  triggerDownload: vi.fn(),
  buildDownloadUrl: (url) => 'https://proxy/?url=' + encodeURIComponent(url),
  buildVideoFilename: () => 'video.mp4',
  buildImageFilename: (_video, index) => index + '.jpg',
  buildLivePhotoFilename: (_video, index) => index + '.mp4',
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
  global.window = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout }
  const scope = effectScope()
  const app = scope.run(() => useVideoPage())
  cleanups.push(() => scope.stop())
  return { app, downloads }
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
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(65 * 1024 * 1024) },
    })
  await app.handleDownloadAllPreferred()
  assert.equal(clicks.length, 1)
  assert.match(app.batchProgress.value, /64 MB/)
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
    return 'blob:test-video'
  }
  URL.revokeObjectURL = (url) => revoked.push(url)
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 60000 ? 0 : ms, ...args)
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
        'Content-Length': String(65 * 1024 * 1024),
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
