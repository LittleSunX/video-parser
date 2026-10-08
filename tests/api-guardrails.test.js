import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import worker from '../worker/src/index'
import { AppError } from '../worker/src/errors/app-error.ts'
import { errorResponse } from '../worker/src/utils/error-response.ts'
import { readVideoResponse } from '../frontend/src/api/response.ts'
const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})
const allowed = { limit: async () => ({ success: true }) }
const env = { PARSE_RATE_LIMITER: allowed, DOWNLOAD_RATE_LIMITER: allowed }
function parseRequest(body, headers = {}) {
  return new Request('https://api.example.com/api/parse', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers },
  })
}
function downloadRequest(headers = {}) {
  return new Request(
    'https://api.example.com/api/download?url=' +
      encodeURIComponent('https://v.douyinvod.com/video.mp4'),
    { headers },
  )
}

test('parse rate limit returns 429 and a readable retry interval before upstream fetch', async () => {
  let key
  global.fetch = async () => {
    assert.fail('rate limited requests must not reach upstream')
  }
  const response = await worker.fetch(
    parseRequest('{"url":"https://www.douyin.com/video/123"}', {
      'X-Forwarded-For': '203.0.113.99',
    }),
    {
      ...env,
      PARSE_RATE_LIMITER: {
        limit: async (options) => {
          key = options.key
          return { success: false }
        },
      },
    },
  )
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '60')
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /Retry-After/)
  assert.equal((await response.json()).error.code, 'RATE_LIMITED')
  assert.equal(key, 'video-parser:parse:192.0.2.1')
})

test('download quota is independent and counts Range requests too', async () => {
  let calls = 0
  const response = await worker.fetch(
    downloadRequest({ Range: 'bytes=0-10', 'CF-Connecting-IP': '192.0.2.2' }),
    {
      PARSE_RATE_LIMITER: { limit: async () => assert.fail('wrong quota') },
      DOWNLOAD_RATE_LIMITER: {
        limit: async ({ key }) => {
          calls++
          assert.equal(key, 'video-parser:download:192.0.2.2')
          return { success: false }
        },
      },
    },
  )
  assert.equal(calls, 1)
  assert.equal(response.status, 429)
})

test('health and CORS preflight do not consume rate limits', async () => {
  const unavailable = { limit: async () => assert.fail('no limiter needed') }
  const bindings = { PARSE_RATE_LIMITER: unavailable, DOWNLOAD_RATE_LIMITER: unavailable }
  assert.equal(
    (await worker.fetch(new Request('https://api.example.com/api/health'), bindings)).status,
    200,
  )
  const response = await worker.fetch(
    new Request('https://api.example.com/api/parse', { method: 'OPTIONS' }),
    bindings,
  )
  assert.equal(response.status, 204)
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Range/)
})

test('missing or failing rate limiter does not silently disable protection', async () => {
  const missing = await worker.fetch(parseRequest('{}'), {})
  assert.equal(missing.status, 503)
  const failed = await worker.fetch(parseRequest('{}'), {
    ...env,
    PARSE_RATE_LIMITER: {
      limit: async () => {
        throw new Error('internal binding failure')
      },
    },
  })
  assert.equal(failed.status, 503)
  assert.doesNotMatch(await failed.text(), /internal binding failure/)
})

test('null, arrays, invalid JSON and missing URL return 400 rather than 500', async () => {
  global.fetch = async () => assert.fail('invalid input must not reach upstream')
  for (const body of ['null', '[]', '{}', '{', '123', '"text"', '{"url":12}', '{"url":"  "}']) {
    const response = await worker.fetch(parseRequest(body), env)
    assert.equal(response.status, 400, body)
    assert.equal((await response.json()).error.code, 'INVALID_INPUT')
  }
})

test('unsupported content types are rejected with 415', async () => {
  const response = await worker.fetch(parseRequest('{}', { 'Content-Type': 'text/plain' }), env)
  assert.equal(response.status, 415)
})

test('form submissions use the same parser and retain video metadata', async () => {
  let calls = 0
  const source = 'https://www.douyin.com/video/123?caption=a%2Bb&from=share'
  global.fetch = async () => {
    calls++
    return Response.json({
      aweme_detail: {
        aweme_id: '123',
        desc: '分享文案 + & 中文',
        author: { nickname: '作者' },
        video: {
          play_addr: { url_list: ['https://v.douyinvod.com/video.mp4'] },
          cover: { url_list: ['https://p.douyinpic.com/cover.jpg'] },
        },
        music: { title: '音乐', play_url: { url_list: ['https://music.douyinvod.com/audio.mp3'] } },
      },
    })
  }
  const response = await worker.fetch(
    new Request('https://api.example.com/api/parse', {
      method: 'POST',
      body: new URLSearchParams({ url: `复制分享 + & 中文 ${source}` }),
    }),
    env,
  )
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(calls, 1)
  assert.equal(data.videoId, '123')
  assert.equal(data.sourceUrl, source)
  assert.equal(data.author, '作者')
  assert.equal(data.cover, 'https://p.douyinpic.com/cover.jpg')
  assert.equal(data.musicTitle, '音乐')
  assert.equal(data.musicUrl, 'https://music.douyinvod.com/audio.mp3')
})

test('form submissions reject missing, duplicate and oversized input before fetching', async () => {
  global.fetch = async () => assert.fail('invalid form must not reach upstream')
  for (const [body, status] of [
    ['', 400],
    ['other=value', 400],
    ['url=+', 400],
    ['url=https%3A%2F%2Fwww.douyin.com%2Fvideo%2F123&url=another', 400],
    [new URLSearchParams({ url: 'x'.repeat(5001) }).toString(), 413],
    [
      new URLSearchParams({
        url: 'https://www.douyin.com/video/123',
        padding: 'x'.repeat(32768),
      }).toString(),
      413,
    ],
  ]) {
    const response = await worker.fetch(
      parseRequest(body, { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }),
      env,
    )
    assert.equal(response.status, status)
  }
})

test('form submissions retain URL validation and rate limits', async () => {
  global.fetch = async () => assert.fail('rejected form must not reach upstream')
  const request = (url) =>
    new Request('https://api.example.com/api/parse', {
      method: 'POST',
      body: new URLSearchParams({ url }),
    })
  for (const url of [
    'https://example.com/video/123',
    'https://user:pass@www.douyin.com/video/123',
  ]) {
    const response = await worker.fetch(request(url), env)
    assert.equal(response.status, 400)
  }
  const response = await worker.fetch(request('https://www.douyin.com/video/123'), {
    ...env,
    PARSE_RATE_LIMITER: { limit: async () => ({ success: false }) },
  })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '60')
})

test('body cap applies without Content-Length and also enforces URL character limit', async () => {
  for (const body of [
    JSON.stringify({ url: 'x'.repeat(5001) }),
    JSON.stringify({ url: 'https://v.douyin.com/a', padding: 'x'.repeat(32768) }),
  ]) {
    const response = await worker.fetch(parseRequest(body), env)
    assert.equal(response.status, 413)
  }
})

test('download URL credentials and custom ports are rejected before fetching', async () => {
  global.fetch = async () => assert.fail('invalid URL must not reach upstream')
  for (const url of ['https://user:password@v.douyinvod.com/a', 'https://v.douyinvod.com:444/a']) {
    const response = await worker.fetch(
      new Request('https://api.example.com/api/download?url=' + encodeURIComponent(url)),
      env,
    )
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_URL')
  }
})

test('expired or inaccessible media gives a reparse suggestion without upstream details', async () => {
  global.fetch = async () => new Response('internal upstream text', { status: 403 })
  const response = await worker.fetch(downloadRequest(), env)
  assert.equal(response.status, 422)
  const payload = await response.json()
  assert.equal(payload.error.code, 'MEDIA_UNAVAILABLE')
  assert.match(payload.error.message, /重新解析/)
  assert.doesNotMatch(payload.error.message, /403|internal/)
})

test('successful proxy downloads still stream Range responses', async () => {
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-2')
    return new Response('abc', {
      status: 206,
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-2/10' },
    })
  }
  const response = await worker.fetch(downloadRequest({ Range: 'bytes=0-2' }), env)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-2/10')
  assert.match(response.headers.get('Content-Disposition'), /attachment/)
  assert.equal(await response.text(), 'abc')
})

test('technical parser diagnostics are not exposed in API messages', async () => {
  const response = errorResponse(
    new AppError(
      'VIDEO_RESOURCE_NOT_FOUND',
      'web-detail: secret diagnostic; mobile-feed: HTTP 403',
      422,
    ),
    'parse',
  )
  const payload = await response.json()
  assert.match(payload.error.message, /公开访问/)
  assert.doesNotMatch(payload.error.message, /secret|web-detail|403/)
})

test('frontend handles rate limits even when the edge returns HTML', async () => {
  await assert.rejects(
    readVideoResponse(
      new Response('<html>rate limited</html>', { status: 429, headers: { 'Retry-After': '60' } }),
    ),
    /60 秒/,
  )
  await assert.rejects(
    readVideoResponse(new Response('<html>gateway</html>', { status: 504 })),
    /超时/,
  )
})

test('frontend rejects malformed payloads and preserves useful API error messages', async () => {
  for (const data of [null, {}, { success: true, data: {} }]) {
    await assert.rejects(readVideoResponse(Response.json(data)), /异常|不完整/)
  }
  await assert.rejects(
    readVideoResponse(
      Response.json(
        { success: false, error: { message: '请重新复制作品分享链接' } },
        { status: 422 },
      ),
    ),
    /重新复制/,
  )
  const valid = {
    platform: 'douyin',
    mediaType: 'video',
    videoId: '123',
    title: 'Test',
    sourceUrl: 'https://www.douyin.com/video/123',
    videoUrl: 'https://v.douyinvod.com/video.mp4',
  }
  assert.deepEqual(await readVideoResponse(Response.json({ success: true, data: valid })), valid)
  for (const state of [
    { parseStatus: 'complete', parseReason: 'complete' },
    { parseStatus: 'unverified', parseReason: 'timeout' },
    { parseStatus: 'unverified', parseReason: 'exhausted' },
  ]) {
    const data = { ...valid, ...state }
    assert.deepEqual(await readVideoResponse(Response.json({ success: true, data })), data)
  }
  for (const state of [
    { parseStatus: 'complete', parseReason: 'timeout' },
    { parseStatus: 'unverified', parseReason: 'complete' },
    { parseStatus: 'complete' },
    { parseReason: 'exhausted' },
    { parseStatus: 'unexpected', parseReason: 'unexpected' },
  ]) {
    await assert.rejects(
      readVideoResponse(Response.json({ success: true, data: { ...valid, ...state } })),
      /解析状态异常/,
    )
  }
})

test('frontend validates image completeness independently of strategy and watermark status', async () => {
  const image = {
    platform: 'douyin',
    mediaType: 'image',
    videoId: '123',
    title: 'Test',
    sourceUrl: 'https://www.douyin.com/note/123',
    images: [{ url: 'https://p.douyinpic.com/image.jpg', watermarkFree: false }],
    parseStatus: 'unverified',
    parseReason: 'exhausted',
  }
  for (const imagesComplete of [true, false, undefined]) {
    const data = { ...image, imagesComplete }
    const payload = Response.json({ success: true, data })
    assert.equal((await readVideoResponse(payload)).imagesComplete, imagesComplete)
  }
  for (const state of [
    { imagesComplete: 'true' },
    { imagesComplete: null },
    { imagesComplete: true, images: [] },
    { imagesComplete: true, images: [{ url: '', livePhotoUrl: 'https://live/video' }] },
    { imagesComplete: true, mediaType: 'video', videoUrl: 'https://video/example' },
  ]) {
    await assert.rejects(
      readVideoResponse(Response.json({ success: true, data: { ...image, ...state } })),
      /资源状态异常/,
    )
  }
})
