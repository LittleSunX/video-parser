import { expect, test } from 'vitest'
import { mapItemToVideoInfo } from '../backend/src/parsers/douyin/map-item'
import { readVideoPayload } from '../frontend/src/api/response'
import { mergeMetadata } from '../backend/src/parsers/douyin/ordered-candidates'

const id = '1234567890123456789'
const source = new URL('https://www.douyin.com/video/' + id)
const stream = (url, width, size) => ({
  play_addr: { url_list: [url], width, height: width, data_size: size },
})
const map = (video) => mapItemToVideoInfo({ aweme_id: id, video }, source, id).video

test('size stays paired with the selected highest quality URL across metadata supplementation', () => {
  const result = map({
    bit_rate: [stream('https://cdn/low', 720, 200), stream('https://cdn/high', 1080, '100')],
  })
  expect(result.videoUrl).toBe('https://cdn/high')
  expect(result.videoSize).toBe(100)
  const merged = mergeMetadata(result, {
    ...result,
    videoUrl: 'https://cdn/other',
    videoSize: 999,
    author: '作者',
  })
  expect(merged).toMatchObject({ videoUrl: result.videoUrl, videoSize: 100, author: '作者' })
  expect(readVideoPayload({ success: true, data: merged }, new Response()).videoSize).toBe(100)
})

test.each([undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 'invalid'])(
  'invalid or missing upstream size %s is omitted without losing the video',
  (size) => {
    const result = map({ bit_rate: [stream('https://cdn/video', 1080, size)] })
    expect(result.videoUrl).toBe('https://cdn/video')
    expect(result).not.toHaveProperty('videoSize')
  },
)

test('rewritten watermark URLs and unselected default stream sizes are not used as size hints', () => {
  const rewritten = map({ bit_rate: [stream('https://cdn/playwm/?watermark=1', 1080, 100)] })
  expect(rewritten.videoUrl).toBe('https://cdn/play/')
  expect(rewritten).not.toHaveProperty('videoSize')
  const result = map({
    play_addr: { url_list: ['https://cdn/default'], data_size: 999 },
    bit_rate: [stream('https://cdn/high', 1080)],
  })
  expect(result).not.toHaveProperty('videoSize')
})

test.each([0, -1, 1.5, '100', null, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'frontend rejects malformed size %s but accepts older responses without size',
  (size) => {
    const result = map({ play_addr: { url_list: ['https://cdn/video'] } })
    expect(readVideoPayload({ success: true, data: result }, new Response())).toEqual(result)
    expect(() =>
      readVideoPayload({ success: true, data: { ...result, videoSize: size } }, new Response()),
    ).toThrow('视频大小信息异常')
  },
)
