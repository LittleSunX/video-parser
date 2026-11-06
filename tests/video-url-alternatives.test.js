import { expect, test } from 'vitest'
import { mapItemToVideoInfo } from '../backend/src/parsers/douyin/map-item'
import { mergeKnownResults, mergeMetadata } from '../backend/src/parsers/douyin/ordered-candidates'
import { readVideoPayload } from '../frontend/src/api/response'
import { validateVideoInfo } from '../shared/video-contract'
import { MAX_VIDEO_URL_ALTERNATIVES } from '../shared/video'

const id = '1234567890123456789'
const source = new URL('https://www.douyin.com/video/' + id)
const primary = 'https://v26.douyinvod.com/high.mp4?signature=a%2Fb&expires=123'
const mirror = 'https://v11.douyinvod.com/high.mp4?signature=c%2Fd&expires=123'
const third = 'https://www.douyin.com/aweme/v1/play/?video_id=fixture&line=0'
const stream = (urls, width = 1080, size = 7934704) => ({
  play_addr: { url_list: urls, width, height: width, data_size: size },
})
const map = (video) => mapItemToVideoInfo({ aweme_id: id, video }, source, id).video

test('retains only the selected highest-quality stream HTTPS alternatives and their signatures', () => {
  const result = map({
    bit_rate: [
      stream(['https://v3.douyinvod.com/low.mp4'], 720, 100),
      stream([
        primary.replace('https:', 'http:'),
        primary,
        primary,
        mirror,
        third,
        'https://v99.douyinvod.com/unused.mp4',
      ]),
    ],
    play_addr: { url_list: ['https://v4.douyinvod.com/default.mp4'] },
    download_addr: { url_list: ['https://v5.douyinvod.com/download.mp4'] },
  })
  expect(result).toMatchObject({
    videoUrl: primary,
    videoUrlAlternatives: [mirror, third],
    videoSize: 7934704,
  })
  expect(result.videoUrlAlternatives).toHaveLength(MAX_VIDEO_URL_ALTERNATIVES)
  expect(readVideoPayload({ success: true, data: result }, new Response())).toEqual(result)
})

test('alternative extraction follows existing address alias order and normalizes escaped URLs once', () => {
  const result = map({
    bit_rate: [
      {
        play_addr: {
          url_list: [primary],
          urlList: [{ url: mirror.replaceAll('/', '\\/') }],
          src: third,
        },
      },
    ],
  })
  expect(result).toMatchObject({ videoUrl: primary, videoUrlAlternatives: [mirror, third] })
})

test.each([
  { bit_rate: [stream([primary])] },
  { bit_rate: [stream([primary.replace('https:', 'http:')])] },
  {
    bit_rate: [stream(['https://v3.douyinvod.com/playwm/?watermark=1', mirror])],
  },
])('older single-address and transformed results omit alternatives: %j', (video) => {
  expect(map(video)).not.toHaveProperty('videoUrlAlternatives')
})

test.each(['play_addr', 'play_addr_h264', 'download_addr'])(
  'keeps same-stream alternatives when the chosen address is %s without a bitrate list',
  (key) => {
    const result = map({ [key]: { url_list: [primary, mirror, third] } })
    expect(result).toMatchObject({ videoUrl: primary, videoUrlAlternatives: [mirror, third] })
    expect(result).not.toHaveProperty('videoSize')
  },
)

test('fallback address alternatives do not mix other streams or transformed watermark addresses', () => {
  const result = map({
    bit_rate: [{}],
    play_addr: { url_list: [primary, mirror] },
    play_addr_h264: { url_list: [third] },
    download_addr: { url_list: ['https://v5.douyinvod.com/different.mp4'] },
  })
  expect(result).toMatchObject({ videoUrl: primary, videoUrlAlternatives: [mirror] })
  expect(
    map({ play_addr: { url_list: ['https://v3.douyinvod.com/playwm/?watermark=1', mirror] } }),
  ).not.toHaveProperty('videoUrlAlternatives')
})

test('metadata supplementation keeps the selected stream, size and alternatives together', () => {
  const selected = map({ bit_rate: [stream([primary, mirror])] })
  const incoming = map({
    bit_rate: [stream([third, 'https://v5.douyinvod.com/other.mp4'], 720, 100)],
  })
  expect(mergeMetadata(selected, { ...incoming, author: '作者' })).toMatchObject({
    videoUrl: primary,
    videoUrlAlternatives: [mirror],
    videoSize: 7934704,
    author: '作者',
  })
  expect(
    mergeKnownResults(
      { video: selected, imagesComplete: true },
      { video: incoming, imagesComplete: true },
    ).video,
  ).toMatchObject({ videoUrl: primary, videoUrlAlternatives: [mirror], videoSize: 7934704 })
})

test('conversion to a known image list removes video alternatives together with the video URL', () => {
  const selected = map({ bit_rate: [stream([primary, mirror])] })
  const image = { url: 'https://p.douyinpic.com/still.jpg' }
  const result = mergeKnownResults(
    { video: { ...selected, images: [image] }, imagesComplete: false },
    { video: { ...selected, mediaType: 'image', images: [image] }, imagesComplete: true },
  ).video
  expect(result.mediaType).toBe('image')
  expect(result).not.toHaveProperty('videoUrl')
  expect(result).not.toHaveProperty('videoUrlAlternatives')
  expect(result).not.toHaveProperty('videoSize')
})

test.each([undefined, [], [mirror], [mirror, third]])(
  'the additive contract accepts an optional bounded alternatives array: %j',
  (videoUrlAlternatives) => {
    const result = { ...map({ play_addr: { url_list: [primary] } }), videoUrlAlternatives }
    expect(validateVideoInfo(result)).toEqual({ valid: true, value: result })
  },
)

test.each([
  null,
  'https://v11.douyinvod.com/video.mp4',
  [1],
  [mirror, {}],
  [mirror, third, primary],
])('the contract rejects malformed or excessive alternatives: %j', (videoUrlAlternatives) => {
  const result = { ...map({ play_addr: { url_list: [primary] } }), videoUrlAlternatives }
  expect(validateVideoInfo(result)).toEqual({ valid: false, issue: 'resource' })
})
