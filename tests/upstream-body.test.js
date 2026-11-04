import { afterEach, expect, test, vi } from 'vitest'
import { readUpstreamText, MAX_UPSTREAM_BODY_BYTES } from '../backend/src/utils/upstream-body'
import { DouyinParser } from '../backend/src/parsers/douyin'
import { resolveSupportedUrl } from '../backend/src/utils/url'

afterEach(() => vi.unstubAllGlobals())

test('bounded reading preserves UTF-8 across chunks and accepts exactly the byte limit', async () => {
  const bytes = new TextEncoder().encode('中文😀')
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    }),
  )
  expect(await readUpstreamText(response, undefined, bytes.length)).toBe('中文😀')
  expect(response.body.locked).toBe(false)
  expect(await readUpstreamText(new Response(null))).toBe('')
})

test.each([{}, { 'Content-Length': '1' }, { 'Content-Encoding': 'gzip', 'Content-Length': '1' }])(
  'actual bytes enforce the budget despite missing or misleading headers: %j',
  async (headers) => {
    const cancel = vi.fn(() => new Promise(() => {}))
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5))
        },
        cancel,
      }),
      { headers },
    )
    await expect(readUpstreamText(response, undefined, 4)).rejects.toHaveProperty(
      'code',
      'UPSTREAM_RESPONSE_TOO_LARGE',
    )
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body.locked).toBe(false)
  },
)

test('declared identity size is rejected before reading, but encoded length is not decoded length', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { 'Content-Length': '5' },
  })
  await expect(readUpstreamText(response, undefined, 4)).rejects.toHaveProperty(
    'code',
    'UPSTREAM_RESPONSE_TOO_LARGE',
  )
  expect(cancel).toHaveBeenCalledOnce()
  expect(
    await readUpstreamText(
      new Response('ok', {
        headers: { 'Content-Length': '100', 'Content-Encoding': 'gzip' },
      }),
      undefined,
      4,
    ),
  ).toBe('ok')
})

test.each(['AbortError', 'TimeoutError'])(
  'a stalled read exits on %s without waiting for remote cleanup',
  async (name) => {
    const controller = new AbortController()
    const cancel = vi.fn(() => new Promise(() => {}))
    const response = new Response(new ReadableStream({ cancel }))
    const pending = readUpstreamText(response, controller.signal)
    const rejected = expect(pending).rejects.toHaveProperty('name', name)
    controller.abort(new DOMException('stop', name))
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body.locked).toBe(false)
  },
)

test('an already aborted read cancels its response and stream failures release the lock', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }))
  await expect(readUpstreamText(response, AbortSignal.abort())).rejects.toHaveProperty(
    'name',
    'AbortError',
  )
  expect(cancel).toHaveBeenCalledOnce()
  const failed = new Response(
    new ReadableStream({
      start(c) {
        c.error(new Error('broken'))
      },
    }),
  )
  await expect(readUpstreamText(failed)).rejects.toThrow('broken')
  expect(failed.body.locked).toBe(false)
})

test('oversized primary JSON falls back to a valid feed without changing resource selection', async () => {
  const cancelled = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (url.includes('/web/'))
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(MAX_UPSTREAM_BODY_BYTES + 1))
            },
            cancel: cancelled,
          }),
        )
      if (url.includes('/feed/'))
        return Response.json({
          aweme_list: [
            {
              aweme_id: '123',
              desc: 'valid fallback',
              video: { play_addr: { url_list: ['https://v.douyinvod.com/video.mp4'] } },
            },
          ],
        })
      return new Response('missing', { status: 404 })
    }),
  )
  const result = await new DouyinParser().parse('https://www.douyin.com/video/123')
  expect(result.videoUrl).toBe('https://v.douyinvod.com/video.mp4')
  expect(result.title).toBe('valid fallback')
  expect(cancelled).toHaveBeenCalled()
})

test('short-link HTML is subject to the same body budget', async () => {
  const cancel = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { 'Content-Length': String(MAX_UPSTREAM_BODY_BYTES + 1) },
        }),
    ),
  )
  await expect(resolveSupportedUrl(new URL('https://v.douyin.com/sample/'))).rejects.toHaveProperty(
    'code',
    'UPSTREAM_RESPONSE_TOO_LARGE',
  )
  expect(cancel).toHaveBeenCalledOnce()
})
