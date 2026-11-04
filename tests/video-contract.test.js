import { expect, test } from 'vitest'
import { validateVideoInfo } from '../shared/video-contract'
import { readVideoPayload, readVideoResponse } from '../frontend/src/api/response'
import { readParseStream } from '../frontend/src/api/parse-stream'

const base = {
  platform: 'douyin',
  mediaType: 'video',
  videoId: '123',
  title: '作品',
  sourceUrl: 'https://www.douyin.com/video/123',
  videoUrl: 'https://v.douyinvod.com/video',
}
const read = (data) => readVideoPayload({ success: true, data }, new Response())

test.each([
  base,
  {
    ...base,
    videoSize: 100,
    duration: 0,
    author: '',
    parseStatus: 'complete',
    parseReason: 'complete',
  },
  { ...base, futureCapability: { version: 2 } },
  {
    ...base,
    mediaType: 'image',
    videoUrl: undefined,
    images: [{ url: '', livePhotoUrl: 'https://v.douyinvod.com/live' }],
    imagesComplete: false,
  },
  {
    ...base,
    mediaType: 'image',
    videoUrl: undefined,
    images: [{ url: 'https://p.douyinpic.com/image' }],
    imagesComplete: true,
    parseStatus: 'unverified',
    parseReason: 'exhausted',
  },
])('legacy, additive and partial results remain compatible: %j', async (data) => {
  expect(validateVideoInfo(data)).toEqual({ valid: true, value: data })
  expect(read(data)).toEqual(data)
  expect(await readVideoResponse(Response.json({ success: true, data }))).toEqual(data)
  const body = JSON.stringify({ type: 'result', data }) + '\n'
  expect(await readParseStream(new Response(body))).toEqual(data)
})

test.each([
  { author: {} },
  { cover: [] },
  { musicUrl: 2 },
  { musicTitle: null },
  { duration: -1 },
  { duration: Infinity },
  { duration: '100' },
  { mediaType: 'image', images: [{ url: 'image', livePhotoUrl: {} }] },
  { mediaType: 'image', images: [{ url: 'image', watermarkFree: 'true' }] },
  { images: {} },
  { mediaType: 'image', images: [null] },
  { parseStatus: 'complete', parseReason: 'timeout' },
])('invalid known fields fail at the boundary in both transports: %j', async (fields) => {
  const data = { ...base, ...fields }
  expect(() => read(data)).toThrow()
  // JSON serialization maps Infinity to null, which must also be rejected.
  await expect(readVideoResponse(Response.json({ success: true, data }))).rejects.toHaveProperty(
    'code',
    'INVALID_RESPONSE',
  )
  await expect(
    readParseStream(new Response(JSON.stringify({ type: 'result', data }) + '\n')),
  ).rejects.toHaveProperty('code', 'INVALID_RESPONSE')
})

test('JSON and preview frames apply the same validation before showing metadata', async () => {
  let observed = false
  const data = { ...base, author: { unexpected: true } }
  await expect(
    readParseStream(
      new Response(JSON.stringify({ type: 'preview', data }) + '\n'),
      undefined,
      () => {
        observed = true
      },
    ),
  ).rejects.toHaveProperty('code', 'INVALID_RESPONSE')
  expect(observed).toBe(false)
})
