import { afterEach, expect, test, vi } from 'vitest'
import {
  decodeHtmlEntities,
  extractFirstUrl,
  extractHttpsUrls,
  toPlayableUrl,
} from '../backend/src/parsers/douyin/text'
import { mapItemToVideoInfo } from '../backend/src/parsers/douyin/map-item'
import { extractLivePhotoUrl, selectBestImageUrl } from '../backend/src/parsers/douyin/images'
import { validateVideoInfo } from '../shared/video-contract'
import worker from '../worker/src/index'

const id = '7690537093143539065'
const source = new URL('https://www.douyin.com/video/' + id)
const http = 'http://v.douyinvod.com/fixture.mp4'
const https = 'https://v.douyinvod.com/fixture.mp4'

afterEach(() => vi.unstubAllGlobals())

test.each([
  ['flat list', [http, https]],
  ['nested list', [[http], [{ url_list: [https] }]]],
  ['address aliases', { url_list: [http], urlList: [https] }],
  ['scalar aliases', { url: http, src: https }],
  ['escaped HTTPS', { url_list: [http, https.replaceAll('/', '\\/')] }],
])('prefers an existing HTTPS media candidate in a %s', (_label, candidates) => {
  expect(extractFirstUrl(candidates)).toBe(https)
})

test('keeps the upstream order among HTTPS candidates', () => {
  expect(extractFirstUrl([http, https, 'https://v.douyinvod.com/backup.mp4'])).toBe(https)
})

test('preserves an HTTP-only candidate without inventing a different signed URL', () => {
  expect(extractFirstUrl(['invalid', http])).toBe(http)
  expect(extractFirstUrl({ url_list: [http], url: 'invalid' })).toBe(http)
  expect(extractFirstUrl('invalid')).toBeUndefined()
})

test('prefers HTTPS for video, music and cover addresses from the same item', () => {
  const cover = 'https://p.douyinpic.com/cover.jpg'
  const music = 'https://sf3.douyinstatic.com/music.mp3'
  const result = mapItemToVideoInfo(
    {
      aweme_id: id,
      video: {
        play_addr: { url_list: [http, https] },
        cover: { url_list: [cover.replace('https:', 'http:'), cover] },
      },
      music: { play_url: { url_list: [music.replace('https:', 'http:'), music] } },
    },
    source,
    id,
  ).video
  expect(result).toMatchObject({ videoUrl: https, cover, musicUrl: music })
})

test('keeps the highest quality stream and its size while selecting its HTTPS address', () => {
  const high = 'https://v.douyinvod.com/high.mp4'
  const result = mapItemToVideoInfo(
    {
      aweme_id: id,
      video: {
        bit_rate: [
          { play_addr: { url_list: [https], width: 720, height: 720, data_size: 100 } },
          {
            play_addr: {
              url_list: [high.replace('https:', 'http:'), high],
              width: 1080,
              height: 1080,
              data_size: 200,
            },
          },
        ],
      },
    },
    source,
    id,
  ).video
  expect(result).toMatchObject({ videoUrl: high, videoSize: 200 })
})

test('the chosen HTTPS candidate can pass through the actual download handler', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([0, 128, 255, 1]), { headers: { 'Content-Type': 'video/mp4' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const result = mapItemToVideoInfo(
    { aweme_id: id, video: { play_addr: { url_list: [http, https] } } },
    source,
    id,
  ).video
  const response = await worker.fetch(
    new Request('https://api.example.com/api/download?url=' + encodeURIComponent(result.videoUrl)),
    { DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } },
  )
  expect(response.status).toBe(200)
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 128, 255, 1])
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe(https)
})

test('an HTTPS image wins over an HTTP image within the same source even if it is WebP', () => {
  const image = 'https://p.douyinpic.com/fixture.webp'
  const result = mapItemToVideoInfo(
    {
      aweme_id: id,
      images: [
        {
          watermark_free_download_url_list: ['http://p.douyinpic.com/fixture.jpg', image],
        },
      ],
    },
    source,
    id,
  ).video
  expect(result.images).toEqual([{ url: image, watermarkFree: true }])
  expect(result.cover).toBe(image)
})

test('image watermark and source quality ranks still take precedence over protocol preference', () => {
  const origin = 'http://p.douyinpic.com/original.jpg'
  expect(
    selectBestImageUrl({ origin_image: origin, url_list: ['https://p.douyinpic.com/display.jpg'] }),
  ).toMatchObject({ url: origin, watermarkFree: true })
})

test('image address aliases can supply HTTPS without changing secure alias order', () => {
  const image = 'https://p.douyinpic.com/fixture.webp'
  const result = selectBestImageUrl({ origin_image: { url_list: [http], url: image } })
  expect(result).toMatchObject({ url: image, watermarkFree: true })
  expect(
    selectBestImageUrl({
      origin_image: { url_list: [image], url: 'https://p.douyinpic.com/other.jpg' },
    }),
  ).toMatchObject({ url: image })
})

test('HTTPS image aliases cannot discard an earlier clean candidate in favor of a watermarked one', () => {
  const clean = 'http://p.douyinpic.com/clean.jpg'
  expect(
    selectBestImageUrl({
      origin_image: { url_list: [clean], url: 'https://p.douyinpic.com/tplv-dy-water.jpg' },
    }),
  ).toMatchObject({ url: clean, watermarkFree: true })
})

test.each([
  ['HTTP uri with HTTPS alternatives', { uri: http, url_list: [https] }, https],
  ['HTTPS uri with HTTPS alternatives', { uri: https, url_list: [https + '?backup=1'] }, https],
  ['HTTP-only uri', { uri: http }, http],
])('live photos retain the right candidate for %s', (_label, address, expected) => {
  expect(extractLivePhotoUrl({ video: { play_addr: address } })).toBe(expected)
})

test('opaque live IDs still generate HTTPS play URLs ahead of direct address alternatives', () => {
  const url = new URL(
    extractLivePhotoUrl({ video: { play_addr: { uri: 'fixture-live-id', url_list: [https] } } }),
  )
  expect(url.origin).toBe('https://www.iesdouyin.com')
  expect(url.searchParams.get('video_id')).toBe('fixture-live-id')
})

test('live photo address quality order and MP3 fallback exclusion are preserved', () => {
  expect(
    extractLivePhotoUrl({
      video: { play_addr: { uri: http, url_list: ['https://sf3.douyinstatic.com/audio.mp3'] } },
    }),
  ).toBe(http)
  expect(
    extractLivePhotoUrl({
      video: { play_addr: { uri: http }, download_addr: { url_list: [https] } },
    }),
  ).toBe(http)
  expect(
    extractLivePhotoUrl({
      video: { play_addr: { url_list: ['https://sf3.douyinstatic.com/audio.mp3'] } },
    }),
  ).toBeUndefined()
})

test.each([
  [
    'first parameter',
    'https://v.douyinvod.com/playwm/?watermark=1&signature=a%2Fb&line=0',
    'https://v.douyinvod.com/play/?signature=a%2Fb&line=0',
  ],
  [
    'middle parameter',
    'https://v.douyinvod.com/playwm/?video_id=123&watermark=1&signature=a%2Fb',
    'https://v.douyinvod.com/play/?video_id=123&signature=a%2Fb',
  ],
  [
    'trailing parameter',
    'https://v.douyinvod.com/playwm/?video_id=123&watermark=1',
    'https://v.douyinvod.com/play/?video_id=123',
  ],
  [
    'sole parameter',
    'https://v.douyinvod.com/playwm/?watermark=1',
    'https://v.douyinvod.com/play/',
  ],
  [
    'repeated watermark parameters and unrelated watermark_free flag',
    'https://v.douyinvod.com/play/?watermark=1&watermark=0&watermark_free=1&sig=x%2By',
    'https://v.douyinvod.com/play/?watermark_free=1&sig=x%2By',
  ],
  [
    'watermark removal preserves unrelated empty query segments',
    'https://v.douyinvod.com/play/?a=1&&b=2&watermark=1',
    'https://v.douyinvod.com/play/?a=1&&b=2',
  ],
])('toPlayableUrl removes watermark cleanly when it is the %s', (_label, input, expected) => {
  expect(toPlayableUrl(input)).toBe(expected)
})

test.each([
  'https://v26.douyinvod.com/high.mp4?',
  'https://v26.douyinvod.com/high.mp4?a=1&',
  'https://v26.douyinvod.com/high.mp4?a=1&&signature=a%2Fb',
  'https://v26.douyinvod.com/high.mp4?watermark_free=1&a=1&&b=2',
])('toPlayableUrl keeps non-watermarked signed URLs and stream metadata intact: %s', (signed) => {
  const mirror = 'https://v11.douyinvod.com/high.mp4?signature=c%2Fd'
  expect(toPlayableUrl(signed)).toBe(signed)
  const mapped = mapItemToVideoInfo(
    {
      aweme_id: id,
      video: {
        bit_rate: [
          { play_addr: { url_list: [signed, mirror], width: 1080, height: 1920, data_size: 4096 } },
        ],
      },
    },
    source,
    id,
  ).video
  expect(mapped).toMatchObject({
    videoUrl: signed,
    videoUrlAlternatives: [mirror],
    videoSize: 4096,
  })
})

test('decodeHtmlEntities decodes entities in a single pass without double-decoding', () => {
  expect(
    decodeHtmlEntities(
      '&amp;lt;script&amp;gt; &amp;quot;A&amp;#39;B&amp;#x27;C&amp;quot; &lt;&gt;',
    ),
  ).toBe('&lt;script&gt; &quot;A&#39;B&#x27;C&quot; <>')
})

test('candidate extractors skip invalid URLs and omit invalid optional cover/music fields', () => {
  const bad = [
    'https:relative/path',
    'https:/same-origin/path',
    'https://user:pass@v.douyinvod.com/secret.mp4',
    'https://@v.douyinvod.com/secret.mp4',
    'https://',
  ]
  expect(extractFirstUrl([...bad, https])).toBe(https)
  expect(extractHttpsUrls([...bad, https], 3)).toEqual([https])
  expect(
    selectBestImageUrl({ origin_image: [...bad, 'https://p.douyinpic.com/ok.jpg'] })?.url,
  ).toBe('https://p.douyinpic.com/ok.jpg')
  expect(extractLivePhotoUrl({ video: { play_addr: { uri: bad[2], url_list: [https] } } })).toBe(
    https,
  )

  const mapped = mapItemToVideoInfo(
    {
      aweme_id: id,
      video: {
        play_addr: { url_list: [bad[0], https] },
        cover: { url_list: bad },
      },
      music: { title: 'BGM', play_url: { url_list: bad } },
    },
    source,
    id,
  ).video
  expect(mapped.videoUrl).toBe(https)
  expect('cover' in mapped).toBe(false)
  expect('musicUrl' in mapped).toBe(false)
  expect(validateVideoInfo(mapped)).toEqual({ valid: true, value: mapped })
})
