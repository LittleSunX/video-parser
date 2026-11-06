import { afterEach, expect, test, vi } from 'vitest'
import { fetchMediaBlob } from '../frontend/src/utils/auto-download'
import { VIDEO_BUFFER_BYTES } from '../frontend/src/utils/download-buffer'
import { fetchMedia } from '../backend/src/services/media-download'
import worker from '../worker/src/index'

const primary = 'https://v1.douyinvod.com/video.mp4'
const mirror = 'https://v2.douyinvod.com/video.mp4'
const bytes = new Uint8Array([1, 2, 3, 4])
const options = (extra = {}) => ({
  signal: new AbortController().signal,
  onProgress: vi.fn(),
  onSourceReady: vi.fn(),
  ...extra,
})
const partial = (headers = {}, body = bytes) =>
  new Response(body, {
    status: 206,
    headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-3/4', ...headers },
  })

afterEach(() => vi.unstubAllGlobals())

test.each([
  'bytes 0-3/100',
  'bytes 4-7/8',
  'bytes 0-3/*',
  'bytes */4',
  'bytes 0-4/4',
  'bytes 0-0/0',
  'bytes 0-9007199254740991/9007199254740992',
  'invalid',
  '',
])('a partial or unverifiable range never becomes a successful file: %s', async (range) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => partial({ 'Content-Range': range })),
  )
  const handlers = options()
  await expect(fetchMediaBlob(primary, handlers)).rejects.toHaveProperty('code', 'INVALID_MEDIA')
  expect(handlers.onSourceReady).not.toHaveBeenCalled()
  expect(handlers.onProgress).not.toHaveBeenCalled()
})

test('a 206 without an exposed Content-Range rejects before reading or prefetching', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream({ cancel })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 206 })),
  )
  const beforeRead = vi.fn()
  await expect(fetchMediaBlob(primary, options({ beforeRead }))).rejects.toHaveProperty(
    'code',
    'INVALID_MEDIA',
  )
  expect(beforeRead).not.toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledOnce()
})

test.each([{}, { 'Content-Length': '4' }, { 'Content-Encoding': 'identity' }])(
  'a full 206 preserves all bytes and uses the range total for progress: %j',
  async (headers) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => partial(headers)),
    )
    const handlers = options()
    const blob = await fetchMediaBlob(primary, handlers)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
    expect(handlers.onProgress).toHaveBeenLastCalledWith(4, 4)
    expect(handlers.onSourceReady).toHaveBeenCalledExactlyOnceWith(primary)
  },
)

test.each([
  { 'Content-Length': '3' },
  { 'Content-Length': '5' },
  { 'Content-Length': 'invalid' },
  { 'Content-Encoding': 'gzip' },
])('inconsistent or encoded range metadata is rejected: %j', async (headers) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => partial(headers)),
  )
  await expect(fetchMediaBlob(primary, options())).rejects.toHaveProperty('code', 'INVALID_MEDIA')
})

test.each([new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4, 5])])(
  'a full range must actually deliver the stated number of bytes: %j',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => partial({}, body)),
    )
    const handlers = options()
    await expect(fetchMediaBlob(primary, handlers)).rejects.toHaveProperty('code', 'INVALID_MEDIA')
    expect(handlers.onSourceReady).not.toHaveBeenCalled()
  },
)

test('the full range length still enforces the buffer cap when Content-Length is absent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      partial({
        'Content-Range': `bytes 0-${VIDEO_BUFFER_BYTES}/${VIDEO_BUFFER_BYTES + 1}`,
      }),
    ),
  )
  await expect(fetchMediaBlob(primary, options())).rejects.toHaveProperty('code', 'TOO_LARGE')
})

test.each([206, 503])('a rejected HTTP %s primary tries a complete mirror', async (status) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      status === 206
        ? partial({ 'Content-Range': 'bytes 0-3/100' })
        : new Response('temporarily unavailable', { status }),
    )
    .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } }))
  vi.stubGlobal('fetch', fetch)
  const handlers = options({ alternativeUrls: [mirror] })
  const blob = await fetchMediaBlob(primary, handlers)
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([primary, mirror])
  expect(handlers.onSourceReady).toHaveBeenCalledExactlyOnceWith(mirror)
})

test('the fallback API rejects unsolicited partial content before offering an attachment', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => partial({ 'Content-Range': 'bytes 0-3/100' })),
  )
  const response = await worker.fetch(
    new Request('https://api.example.com/api/download?url=' + encodeURIComponent(primary)),
    { DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) } },
  )
  expect(response.status).toBe(502)
  expect(response.headers.has('Content-Disposition')).toBe(false)
  expect((await response.json()).error.code).toBe('DOWNLOAD_FAILED')
})

test('the proxy permits a full 206 and explicit partial Range downloads', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => partial()),
  )
  const complete = await fetchMedia(new URL(primary), null, new AbortController().signal)
  expect(new Uint8Array(await complete.arrayBuffer())).toEqual(bytes)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => partial({ 'Content-Range': 'bytes 0-3/100' })),
  )
  const range = await fetchMedia(new URL(primary), 'bytes=0-3', new AbortController().signal)
  expect(range.status).toBe(206)
  expect(range.headers.get('Content-Range')).toBe('bytes 0-3/100')
  expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes)
})

test.each([new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4, 5])])(
  'the proxy errors instead of completing a full-range stream with incorrect bytes: %j',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => partial({}, body)),
    )
    const response = await fetchMedia(new URL(primary), null, new AbortController().signal)
    await expect(response.arrayBuffer()).rejects.toHaveProperty('code', 'DOWNLOAD_NETWORK_ERROR')
  },
)
