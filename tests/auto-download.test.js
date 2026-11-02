import { afterEach, expect, test, vi } from 'vitest'
import { fetchMediaBlob } from '../frontend/src/utils/auto-download'
import { SINGLE_BUFFER_BYTES, VIDEO_BUFFER_BYTES } from '../frontend/src/utils/download-buffer'

const url = 'https://sf6-cdn-tos.douyinstatic.com/obj/ies-music/music.mp3'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function download(options = {}) {
  return fetchMediaBlob(
    url,
    {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      totalTimeoutMs: 0,
      responseTimeoutMs: 20,
      readTimeoutMs: 30,
      ...options,
    },
    'audio',
  )
}

test.each([
  ['video', 'video/mp4', 65 * 1024 * 1024, true],
  ['video', 'video/mp4', VIDEO_BUFFER_BYTES, true],
  ['video', 'video/mp4', VIDEO_BUFFER_BYTES + 1, false],
  ['image', 'image/jpeg', SINGLE_BUFFER_BYTES, true],
  ['image', 'image/jpeg', SINGLE_BUFFER_BYTES + 1, false],
  ['audio', 'audio/mpeg', SINGLE_BUFFER_BYTES, true],
  ['audio', 'audio/mpeg', SINGLE_BUFFER_BYTES + 1, false],
])(
  'default %s limit handles a %s response of %s bytes (allowed=%s)',
  async (kind, type, size, allowed) => {
    // Only the advertised-size gate is under test; stream-count limits are tested separately below.
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'Content-Type': type, 'Content-Length': String(size) },
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const running = fetchMediaBlob(
      url,
      { signal: new AbortController().signal, onProgress: vi.fn() },
      kind,
    )
    if (allowed)
      expect([...new Uint8Array(await (await running).arrayBuffer())]).toEqual([1, 2, 3, 4])
    else await expect(running).rejects.toHaveProperty('code', 'TOO_LARGE')
    expect(fetch).toHaveBeenCalledOnce()
  },
)

test.each([true, false])(
  'an explicit video cap still applies with Content-Length=%s',
  async (knownLength) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: {
              'Content-Type': 'video/mp4',
              ...(knownLength ? { 'Content-Length': '4' } : {}),
            },
          }),
      ),
    )
    await expect(
      fetchMediaBlob(
        url,
        { signal: new AbortController().signal, onProgress: vi.fn() },
        'video',
        3,
      ),
    ).rejects.toHaveProperty('code', 'TOO_LARGE')
  },
)

test('a successful audio stream preserves bytes, progress and the ordinary CORS GET', async () => {
  vi.useFakeTimers()
  let source
  const body = new ReadableStream({
    start(controller) {
      source = controller
    },
  })
  const fetch = vi.fn(
    async () =>
      new Response(body, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '4' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const onProgress = vi.fn()
  const running = download({ onProgress })
  await vi.advanceTimersByTimeAsync(0)
  source.enqueue(new Uint8Array([1, 2]))
  await vi.advanceTimersByTimeAsync(0)
  expect(onProgress).toHaveBeenLastCalledWith(2, 4)
  source.enqueue(new Uint8Array([3, 4]))
  source.close()
  const blob = await running
  expect(blob.type).toBe('audio/mpeg')
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4])
  expect(onProgress).toHaveBeenLastCalledWith(4, 4)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe(url)
  expect(fetch.mock.calls[0][1]).toMatchObject({
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  expect(fetch.mock.calls[0][1].headers).toBeUndefined()
  expect(fetch.mock.calls[0][1].method).toBeUndefined()
  expect(body.locked).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

test('the response deadline rejects even if fetch never responds to abort', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetch)
  const failed = expect(download()).rejects.toHaveProperty('code', 'TIMEOUT')
  await vi.advanceTimersByTimeAsync(20)
  await failed
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('a stalled partial stream times out without waiting for unfinished underlying cancellation', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn(() => new Promise(() => {}))
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
    },
    cancel,
  })
  const fetch = vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } }))
  vi.stubGlobal('fetch', fetch)
  const onProgress = vi.fn()
  const failed = expect(download({ onProgress })).rejects.toHaveProperty('code', 'TIMEOUT')
  await vi.advanceTimersByTimeAsync(0)
  expect(onProgress).toHaveBeenCalledWith(2, undefined)
  await vi.advanceTimersByTimeAsync(30)
  await failed
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('a response arriving after timeout has its body cancelled without reading or unhandled rejection', async () => {
  vi.useFakeTimers()
  let resolveResponse
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise((resolve) => (resolveResponse = resolve))),
  )
  const onProgress = vi.fn()
  const failed = expect(download({ onProgress })).rejects.toHaveProperty('code', 'TIMEOUT')
  await vi.advanceTimersByTimeAsync(20)
  await failed
  const cancel = vi.fn(async () => {
    throw new Error('late cleanup failed')
  })
  const body = new ReadableStream({ cancel })
  resolveResponse(new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } }))
  await vi.advanceTimersByTimeAsync(0)
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
  expect(onProgress).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['response', 'body'])(
  'external cancellation ends a nonresponsive %s wait immediately',
  async (stage) => {
    vi.useFakeTimers()
    const client = new AbortController()
    const reason = new DOMException('User cancelled', 'AbortError')
    const cancel = vi.fn(() => new Promise(() => {}))
    const body = new ReadableStream({ cancel })
    const fetch = vi.fn(() =>
      stage === 'response'
        ? new Promise(() => {})
        : Promise.resolve(new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } })),
    )
    vi.stubGlobal('fetch', fetch)
    const failed = expect(download({ signal: client.signal })).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    client.abort(reason)
    await failed
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(stage === 'body' ? 1 : 0)
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  },
)

test('an asynchronous reader cancellation failure does not replace the timeout', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn(async () => {
    throw new Error('cleanup failed')
  })
  const body = new ReadableStream({ cancel })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } })),
  )
  const failed = expect(download()).rejects.toHaveProperty('code', 'TIMEOUT')
  await vi.advanceTimersByTimeAsync(30)
  await failed
  await vi.advanceTimersByTimeAsync(0)
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
