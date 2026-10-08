import { afterEach, expect, test, vi } from 'vitest'
import { parseVideo } from '../frontend/src/api/video'
import { readParseInput } from '../worker/src/utils/parse-input'

const source = '复制分享 + & 中文 https://www.douyin.com/video/123?from=a%2Bb&tag=1'
const video = {
  platform: 'douyin',
  mediaType: 'video',
  videoId: '123',
  sourceUrl: 'https://www.douyin.com/video/123',
  title: '标题',
  videoUrl: 'https://v.douyinvod.com/video.mp4',
}

afterEach(() => vi.unstubAllGlobals())

test('the first parse is a readable CORS POST without preflight-triggering headers', async () => {
  const fetch = vi.fn(async (_url, options) => {
    const request = new Request('https://api.example.com/api/parse', options)
    expect(request.method).toBe('POST')
    expect(request.mode).toBe('cors')
    expect(request.credentials).toBe('omit')
    expect([...request.headers.keys()]).toEqual(['content-type'])
    expect(request.headers.get('Content-Type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    )
    expect(await readParseInput(request)).toBe(source)
    return Response.json({ success: true, data: video })
  })
  vi.stubGlobal('fetch', fetch)
  expect(await parseVideo(source)).toEqual(video)
  expect(fetch).toHaveBeenCalledOnce()
})

test('a legacy worker returning 415 gets exactly one JSON fallback', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ success: false, error: { code: 'INVALID_CONTENT_TYPE' } }, { status: 415 }),
    )
    .mockImplementationOnce(async (_url, options) => {
      const request = new Request('https://api.example.com/api/parse', options)
      expect(request.headers.get('Content-Type')).toBe('application/json')
      expect(await readParseInput(request)).toBe(source)
      return Response.json({ success: true, data: video })
    })
  vi.stubGlobal('fetch', fetch)
  expect(await parseVideo(source)).toEqual(video)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test.each([400, 429, 500, 502, 504])('HTTP %s does not cause a second parse', async (status) => {
  const fetch = vi.fn(async () =>
    Response.json({ success: false, error: { message: '请求失败' } }, { status }),
  )
  vi.stubGlobal('fetch', fetch)
  await expect(parseVideo(source)).rejects.toThrow()
  expect(fetch).toHaveBeenCalledOnce()
})

test('cancellation after an unsupported response prevents JSON fallback', async () => {
  const controller = new AbortController()
  const fetch = vi.fn(async () => {
    controller.abort()
    return new Response(null, { status: 415 })
  })
  vi.stubGlobal('fetch', fetch)
  await expect(parseVideo(source, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  expect(fetch).toHaveBeenCalledOnce()
})

test('large percent-encoded text uses JSON to preserve the existing input limits', async () => {
  const input = '中'.repeat(4000) + ' https://www.douyin.com/video/123'
  const fetch = vi.fn(async (_url, options) => {
    const request = new Request('https://api.example.com/api/parse', options)
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(await readParseInput(request)).toBe(input)
    return Response.json({ success: true, data: video })
  })
  vi.stubGlobal('fetch', fetch)
  expect(await parseVideo(input)).toEqual(video)
  expect(fetch).toHaveBeenCalledOnce()
})
