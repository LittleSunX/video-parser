import { afterEach, expect, test, vi } from 'vitest'
import { fetchMedia } from '../backend/src/services/media-download'

const media = new URL('https://v.douyinvod.com/video.mp4')
afterEach(() => vi.unstubAllGlobals())

test('media transport explicitly requests identity bytes, including Range requests', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          'Content-Length': '3',
          'Content-Range': 'bytes 0-2/8',
          'Content-Type': 'video/mp4',
        },
      }),
  )
  vi.stubGlobal('fetch', fetch)
  const response = await fetchMedia(media, 'bytes=0-2', new AbortController().signal)
  const headers = new Headers(fetch.mock.calls[0][1].headers)
  expect(headers.get('Accept-Encoding')).toBe('identity')
  expect(headers.get('Range')).toBe('bytes=0-2')
  expect(response.headers.get('Content-Length')).toBe('3')
  expect(response.headers.get('Content-Range')).toBe('bytes 0-2/8')
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
})

test.each([200, 206, 416])(
  'unexpected encoded media at HTTP %s fails before forwarding incorrect length/range',
  async (status) => {
    const cancel = vi.fn()
    let signal
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        signal = options.signal
        return new Response(new ReadableStream({ cancel }), {
          status,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Encoding': 'gzip',
            'Content-Length': '56',
            'Content-Range': 'bytes 0-55/100',
          },
        })
      }),
    )
    await expect(fetchMedia(media, null, new AbortController().signal)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
      status: 502,
    })
    expect(signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  },
)
