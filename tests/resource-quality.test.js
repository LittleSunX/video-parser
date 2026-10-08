import { test, expect, afterEach, vi } from 'vitest'
import { DouyinParser } from '../worker/src/parsers/douyin'
import { mapItemToVideoInfo } from '../worker/src/parsers/douyin/map-item'
import { runParseStrategies } from '../worker/src/parsers/douyin/strategies'
import { buildImageFilename } from '../frontend/src/utils/download'
import { downloadMediaArchive } from '../frontend/src/utils/batch-download'
import { saveBlob } from '../frontend/src/utils/auto-download'
import { unzipSync } from 'fflate'
import worker from '../worker/src/index'
import { resolveSupportedUrl } from '../worker/src/utils/url'

vi.mock('../frontend/src/utils/auto-download', async (load) => ({
  ...(await load()),
  saveBlob: vi.fn(),
}))
const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
  vi.mocked(saveBlob).mockClear()
})
const id = '7690537093143539065'
const url = new URL('https://www.douyin.com/video/' + id)

test('a single ordinary photo is complete independently of watermark confidence at exhaustion', async () => {
  const sampleId = '7693516298538737329'
  const source = new URL('https://www.iesdouyin.com/share/note/' + sampleId + '/')
  const mapped = mapItemToVideoInfo(
    {
      aweme_id: sampleId,
      desc: '王者万象棋棋手从夯到拉排行！',
      author: { nickname: '天成（王者万象棋）' },
      images: [
        {
          uri: 'ranking-image',
          url_list: ['https://p.douyinpic.com/ranking.jpg'],
          download_url_list: ['https://p.douyinpic.com/ranking-download.jpg'],
          width: 1824,
          height: 2336,
        },
      ],
      music: { title: '@依雾雨创作的原声', play_url: { url_list: ['https://audio/music.mp3'] } },
    },
    source,
    sampleId,
  )
  const fallback = vi.fn(async () => {
    throw new Error('no additional source')
  })
  const result = await runParseStrategies([
    { name: 'web-detail', run: async () => mapped },
    { name: 'fallback', run: fallback },
  ])
  expect(fallback).toHaveBeenCalledOnce()
  expect(result).toMatchObject({
    imagesComplete: true,
    parseStatus: 'unverified',
    parseReason: 'exhausted',
    author: '天成（王者万象棋）',
    musicUrl: 'https://audio/music.mp3',
    musicTitle: '@依雾雨创作的原声',
    images: [{ url: 'https://p.douyinpic.com/ranking.jpg', watermarkFree: false }],
  })
  expect(result.images).toHaveLength(1)
  expect(result.images[0].livePhotoUrl).toBeUndefined()
})

test.each([
  { images: [{ url_list: ['https://images/one'] }, {}] },
  { images: [{ url_list: ['https://images/one'], video: {} }] },
])(
  'known missing image or live resources remain unconfirmed at exhaustion (%j)',
  async ({ images }) => {
    const mapped = mapItemToVideoInfo({ images }, url, id)
    const result = await runParseStrategies([{ name: 'partial', run: async () => mapped }])
    expect(result.imagesComplete).toBe(false)
    expect(result.parseReason).toBe('exhausted')
  },
)

test('a clean still-only source cannot confirm a previously declared missing live track', async () => {
  const mapped = mapItemToVideoInfo(
    { images: [{ uri: 'one', url_list: ['https://images/one'], video: {} }] },
    url,
    id,
  )
  const still = mapItemToVideoInfo(
    { images: [{ uri: 'one', watermark_free_download_url_list: ['https://images/clean'] }] },
    url,
    id,
  )
  const result = await runParseStrategies([
    { name: 'partial-live', run: async () => mapped },
    { name: 'clean-still', run: async () => still },
  ])
  expect(result.images).toHaveLength(1)
  expect(result.images[0].watermarkFree).toBe(true)
  expect(result.images[0].livePhotoUrl).toBeUndefined()
  expect(result.imagesComplete).toBe(false)
})

test('a missing declared live track keeps seeking fallback after clean stills arrive', async () => {
  const item = { images: [{ uri: 'one', url_list: ['https://images/one'], video: {} }] }
  const mapped = mapItemToVideoInfo(item, url, id)
  const still = mapItemToVideoInfo(
    { images: [{ uri: 'one', watermark_free_download_url_list: ['https://images/clean'] }] },
    url,
    id,
  )
  const recovered = mapItemToVideoInfo(
    { images: [{ ...item.images[0], video: { play_addr: { uri: 'live-one' } } }] },
    url,
    id,
  )
  const recoverLive = vi.fn(async () => recovered)
  const result = await runParseStrategies([
    { name: 'partial-live', run: async () => mapped },
    { name: 'clean-still', run: async () => still },
    { name: 'recover-live', run: recoverLive },
  ])
  expect(recoverLive).toHaveBeenCalledOnce()
  expect(result.imagesComplete).toBe(true)
  expect(result.images[0].watermarkFree).toBe(true)
  expect(result.images[0].livePhotoUrl).toContain('video_id=live-one')
})

test('live-only entry continues fallback to recover its still image', async () => {
  let calls = 0
  global.fetch = async () => {
    calls++
    return Response.json({
      aweme_detail: {
        aweme_id: id,
        images: [
          {
            video: { play_addr: { uri: 'live-1' } },
            ...(calls > 1
              ? { watermark_free_download_url_list: ['https://p.douyinpic.com/still.jpg'] }
              : {}),
          },
        ],
      },
    })
  }
  const result = await new DouyinParser().parse(url.toString())
  expect(calls).toBe(2)
  expect(result.images[0].url).toBe('https://p.douyinpic.com/still.jpg')
})

test('same image in supported lists is merged with its live track', () => {
  const still = {
    uri: 'same-image-id',
    watermark_free_download_url_list: ['https://p.douyinpic.com/still.jpg'],
  }
  const result = mapItemToVideoInfo(
    {
      aweme_id: id,
      image_post_info: { images: [still] },
      images: [{ ...still, video: { play_addr: { uri: 'live-1' } } }],
    },
    url,
    id,
  )
  expect(result.video.images).toHaveLength(1)
})

test('proxy rejects HTTP 200 HTML challenge', async () => {
  global.fetch = async () =>
    new Response('<html>verify access</html>', { headers: { 'Content-Type': 'text/html' } })
  const response = await worker.fetch(
    new Request(
      'https://api.example.com/api/download?url=https%3A%2F%2Fv.douyinvod.com%2Fa.mp4&filename=video.mp4',
    ),
    { DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } },
  )
  expect(response.status).toBe(422)
  expect(response.headers.get('Content-Disposition')).toBeNull()
  expect((await response.json()).error.code).toBe('MEDIA_UNAVAILABLE')
})

test('ZIP uses WebP extension without changing bytes', async () => {
  const bytes = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])
  global.fetch = async () => new Response(bytes, { headers: { 'Content-Type': 'image/webp' } })
  const video = { videoId: id, title: 'demo', images: [{ url: 'https://p.douyinpic.com/a.webp' }] }
  const filename = buildImageFilename(video, 0)
  await downloadMediaArchive(
    [{ filename, url: video.images[0].url }],
    'test.zip',
    new AbortController().signal,
    () => {},
  )
  const archive = vi.mocked(saveBlob).mock.calls[0][0]
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()))
  expect(filename.endsWith('.jpg')).toBe(true)
  expect([...files[filename.replace(/\.jpg$/, '.webp')]]).toEqual([...bytes])
})

test('short-link redirects release unused response bodies', async () => {
  const cancel = vi.fn()
  global.fetch = async () =>
    new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: { Location: url.toString() },
    })
  expect((await resolveSupportedUrl(new URL('https://v.douyin.com/demo/'))).toString()).toBe(
    url.toString(),
  )
  expect(cancel).toHaveBeenCalledOnce()
})

test('longer fallback preserves existing live tracks and does not pair unrelated images by position', async () => {
  const { runParseStrategies } = await import('../worker/src/parsers/douyin/strategies')
  const live = [1, 2, 3].map((i) => ({
    url: `https://images/${i}`,
    livePhotoUrl: `https://live/${i}`,
    watermarkFree: false,
  }))
  const still = [3, 2, 1, 4].map((i) => ({ url: `https://images/${i}`, watermarkFree: true }))
  const result = await runParseStrategies([
    { name: 'live', run: async () => ({ video: { images: live }, imagesComplete: true }) },
    { name: 'still', run: async () => ({ video: { images: still }, imagesComplete: true }) },
  ])
  expect(result.images).toHaveLength(4)
  for (const image of result.images) {
    const id = image.url.split('/').pop()
    expect(image.livePhotoUrl).toBe(id === '4' ? undefined : `https://live/${id}`)
    expect(image.watermarkFree).toBe(true)
  }
})

test('stable image identity merges different URLs without leaking metadata into JSON', () => {
  const result = mapItemToVideoInfo(
    {
      aweme_id: id,
      images: [
        { uri: 'same', url_list: ['https://images/old'], video: { play_addr: { uri: 'live' } } },
      ],
      image_list: [
        { uri: 'same', watermark_free_download_url_list: ['https://images/new'] },
        { uri: 'other', url_list: ['https://images/other'] },
      ],
    },
    url,
    id,
  )
  expect(result.video.images).toHaveLength(2)
  expect(result.video.images[0]).toMatchObject({ url: 'https://images/new', watermarkFree: true })
  expect(result.video.images[0].livePhotoUrl).toContain('video_id=live')
  expect(JSON.stringify(result.video.images)).not.toContain('"uri"')
})

test.each([302, 403])('short-link status %s without location releases body', async (status) => {
  const cancel = vi.fn()
  global.fetch = async () => new Response(new ReadableStream({ cancel }), { status })
  await resolveSupportedUrl(new URL('https://v.douyin.com/demo/'))
  expect(cancel).toHaveBeenCalledOnce()
})

test.each(['image/png', 'image/webp'])('single image attachment matches %s', async (mime) => {
  global.fetch = async () =>
    new Response(new Uint8Array([1]), { headers: { 'Content-Type': mime } })
  const response = await worker.fetch(
    new Request(
      'https://api.example.com/api/download?url=https%3A%2F%2Fp.douyinpic.com%2Fa&filename=photo.jpg',
    ),
    { DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } },
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Disposition')).toContain('photo.' + mime.split('/')[1])
  await response.arrayBuffer()
})

test('rejecting non-media cancels upstream body and request', async () => {
  const cancel = vi.fn()
  let signal
  global.fetch = async (_, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ cancel }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const { fetchMedia } = await import('../worker/src/services/media-download')
  await expect(
    fetchMedia(new URL('https://v.douyinvod.com/a'), null, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' })
  expect(signal.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
})

test('unrelated image identities are retained instead of paired by array position', async () => {
  const { runParseStrategies } = await import('../worker/src/parsers/douyin/strategies')
  const first = mapItemToVideoInfo(
    {
      images: [
        { uri: 'one', url_list: ['https://images/one'], video: { play_addr: { uri: 'live-one' } } },
      ],
    },
    url,
    id,
  )
  const second = mapItemToVideoInfo(
    { images: [{ uri: 'two', watermark_free_download_url_list: ['https://images/two'] }] },
    url,
    id,
  )
  const result = await runParseStrategies([
    { name: 'first', run: async () => first },
    { name: 'second', run: async () => second },
  ])
  expect(result.images).toHaveLength(2)
  expect(result.images[0].livePhotoUrl).toContain('video_id=live-one')
  expect(result.images[1].livePhotoUrl).toBeUndefined()
})

test('cross-strategy identity recovers still-only and live-only variants with different URLs', async () => {
  const { runParseStrategies } = await import('../worker/src/parsers/douyin/strategies')
  const first = mapItemToVideoInfo(
    { images: [{ uri: 'one', video: { play_addr: { uri: 'live-one' } } }] },
    url,
    id,
  )
  const second = mapItemToVideoInfo(
    { images: [{ uri: 'one', watermark_free_download_url_list: ['https://images/one'] }] },
    url,
    id,
  )
  expect(first.imagesComplete).toBe(false)
  const result = await runParseStrategies([
    { name: 'first', run: async () => first },
    { name: 'second', run: async () => second },
  ])
  expect(result.images).toHaveLength(1)
  expect(result.images[0].url).toBe('https://images/one')
  expect(result.images[0].livePhotoUrl).toContain('video_id=live-one')
})

test('image extension correction preserves cache keys across a failed batch retry', async () => {
  const { createBatchSession } = await import('../frontend/src/utils/batch-download')
  const jobs = [
    { url: 'https://images/one', filename: 'one.jpg' },
    { url: 'https://images/two', filename: 'two.jpg' },
  ]
  const session = createBatchSession(jobs)
  let fail = true
  let firstRequests = 0
  global.fetch = async (url) => {
    if (url === jobs[0].url) firstRequests++
    else if (fail) throw new Error('offline')
    return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } })
  }
  const run = () =>
    downloadMediaArchive(jobs, 'test.zip', new AbortController().signal, () => {}, session)
  await expect(run()).rejects.toThrow()
  expect(session.files.has('one.jpg')).toBe(true)
  fail = false
  await run()
  expect(firstRequests).toBe(1)
  const archive = vi.mocked(saveBlob).mock.calls[0][0]
  expect(Object.keys(unzipSync(new Uint8Array(await archive.arrayBuffer())))).toEqual([
    'one.png',
    'two.png',
  ])
})
