import { afterEach, expect, test, vi } from 'vitest'
import worker from '../worker/src/index'

const originalFetch = global.fetch
const allowed = { limit: async () => ({ success: true }) }
const env = { DOWNLOAD_RATE_LIMITER: allowed }
const media = 'https://v.douyinvod.com/video.mp4'
const request = (signal) =>
  new Request('https://api.example.com/api/download?url=' + encodeURIComponent(media), { signal })
afterEach(() => {
  global.fetch = originalFetch
  vi.useRealTimers()
})
function pending(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('response timeout returns 504 and aborts upstream', async () => {
  vi.useFakeTimers()
  let signal
  global.fetch = async (_url, options) => {
    signal = options.signal
    return pending(signal)
  }
  const running = worker.fetch(request(), env)
  await vi.advanceTimersByTimeAsync(15000)
  const response = await running
  expect(response.status).toBe(504)
  expect((await response.json()).error.code).toBe('DOWNLOAD_TIMEOUT')
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('client cancellation while connecting returns 499 without waiting for timeout', async () => {
  vi.useFakeTimers()
  const client = new AbortController()
  let signal
  global.fetch = async (_url, options) => {
    signal = options.signal
    return pending(signal)
  }
  const running = worker.fetch(request(client.signal), env)
  await vi.advanceTimersByTimeAsync(0)
  client.abort()
  const response = await running
  expect(response.status).toBe(499)
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('stalled stream fails rather than completing with a truncated file', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  let signal
  global.fetch = async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ cancel }))
  }
  const response = await worker.fetch(request(), env)
  const failed = expect(response.arrayBuffer()).rejects.toHaveProperty('code', 'DOWNLOAD_TIMEOUT')
  await vi.advanceTimersByTimeAsync(30000)
  await failed
  expect(cancel).toHaveBeenCalledOnce()
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['request', 'body'])('cancelling %s during transfer stops upstream', async (mode) => {
  vi.useFakeTimers()
  const client = new AbortController()
  const cancel = vi.fn()
  let signal
  global.fetch = async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ cancel }))
  }
  const response = await worker.fetch(request(client.signal), env)
  if (mode === 'request') {
    const failed = expect(response.arrayBuffer()).rejects.toHaveProperty(
      'code',
      'DOWNLOAD_CANCELLED',
    )
    client.abort()
    await failed
  } else await response.body.cancel()
  await vi.advanceTimersByTimeAsync(0)
  expect(signal.aborted).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('steady transfer can exceed response and idle deadlines without a total timeout', async () => {
  vi.useFakeTimers()
  let source
  global.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller
        },
      }),
    )
  const response = await worker.fetch(request(), env)
  const result = response.arrayBuffer()
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(20000)
    source.enqueue(new Uint8Array([i]))
    await vi.advanceTimersByTimeAsync(0)
  }
  source.close()
  expect([...new Uint8Array(await result)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(vi.getTimerCount()).toBe(0)
})

test('downstream backpressure is not counted as an upstream read timeout', async () => {
  vi.useFakeTimers()
  global.fetch = async () => new Response(new Uint8Array([1, 2, 3]))
  const response = await worker.fetch(request(), env)
  await vi.advanceTimersByTimeAsync(120000)
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
  expect(vi.getTimerCount()).toBe(0)
})

test('redirect body is cancelled and every redirect destination is validated', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  global.fetch = vi.fn(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        status: 302,
        headers: { Location: 'https://example.com/private' },
      }),
  )
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(400)
  expect(global.fetch).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('upstream error response body is released and network failures have a distinct code', async () => {
  const cancel = vi.fn()
  global.fetch = async () => new Response(new ReadableStream({ cancel }), { status: 403 })
  expect((await worker.fetch(request(), env)).status).toBe(422)
  expect(cancel).toHaveBeenCalledOnce()
  global.fetch = async () => {
    throw new TypeError('internal networking details')
  }
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(502)
  const payload = await response.json()
  expect(payload.error.code).toBe('DOWNLOAD_NETWORK_ERROR')
  expect(payload.error.message).not.toContain('internal')
})

test('redirects share a single response deadline', async () => {
  vi.useFakeTimers()
  global.fetch = vi.fn(async (_url, options) => {
    if (global.fetch.mock.calls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 10000))
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://v.douyinvod.com/next.mp4' },
      })
    }
    return pending(options.signal)
  })
  const running = worker.fetch(request(), env)
  await vi.advanceTimersByTimeAsync(15000)
  expect((await running).status).toBe(504)
  expect(global.fetch).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

test('network failure after the first chunk errors the stream and clears timers', async () => {
  vi.useFakeTimers()
  let source
  let signal
  global.fetch = async (_url, options) => {
    signal = options.signal
    return new Response(
      new ReadableStream({
        start(controller) {
          source = controller
          controller.enqueue(new Uint8Array([1]))
        },
      }),
    )
  }
  const response = await worker.fetch(request(), env)
  const reader = response.body.getReader()
  expect((await reader.read()).value).toEqual(new Uint8Array([1]))
  const failed = expect(reader.read()).rejects.toHaveProperty('code', 'DOWNLOAD_NETWORK_ERROR')
  source.error(new TypeError('connection reset'))
  await failed
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
