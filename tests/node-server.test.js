import { afterEach, expect, test, vi } from 'vitest'
import http from 'node:http'

const servers = []
const version = {
  runtime: 'node',
  id: '11111111-1111-4111-8111-111111111111',
  tag: 'a'.repeat(40),
  timestamp: '2026-01-01T00:00:00.000Z',
}
async function start(handler, env = {}) {
  const { createApiServer } = await import('../server/src/server.ts')
  const { readConfig } = await import('../server/src/config.ts')
  const app = createApiServer({ handler, version, config: readConfig(env), logger: vi.fn() })
  servers.push(app)
  const address = await app.listen(0)
  return { app, url: `http://127.0.0.1:${address.port}` }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.shutdown()))
  vi.restoreAllMocks()
})

function expectReceiveTimeout({ elapsedMs, statusCode, error }, timeoutMs, graceMs) {
  if (error) {
    // Node writes a native 408 and immediately destroys the socket. A client
    // still uploading may see ECONNRESET instead, or while reading that 408.
    expect(error.code).toBe('ECONNRESET')
    if (statusCode !== undefined) expect(statusCode).toBe(408)
  } else {
    expect(statusCode).toBe(408)
  }
  expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs)
  expect(elapsedMs).toBeLessThan(timeoutMs + graceMs)
}

test('receive-timeout checks reject early disconnects, unrelated errors and wrong responses', () => {
  const timeoutMs = 10_000
  const graceMs = 3000
  const reset = { code: 'ECONNRESET' }
  for (const outcome of [
    { elapsedMs: timeoutMs - 1, error: reset },
    { elapsedMs: timeoutMs - 1, statusCode: 408 },
    { elapsedMs: timeoutMs + 1, error: { code: 'ECONNREFUSED' } },
    { elapsedMs: timeoutMs + 1, error: reset, statusCode: 500 },
    { elapsedMs: timeoutMs + 1, statusCode: 500 },
    { elapsedMs: timeoutMs + graceMs, error: reset },
  ]) {
    expect(() => expectReceiveTimeout(outcome, timeoutMs, graceMs)).toThrow()
  }
  for (const outcome of [
    { elapsedMs: timeoutMs + 1, error: reset },
    { elapsedMs: timeoutMs + 1, error: reset, statusCode: 408 },
    { elapsedMs: timeoutMs + 1, statusCode: 408 },
  ]) {
    expectReceiveTimeout(outcome, timeoutMs, graceMs)
  }
})

test('trusted malformed identity and handler exceptions fail closed with public CORS diagnostics', async () => {
  const handler = vi.fn(async () => {
    throw Error('PRIVATE_UPSTREAM?token=secret')
  })
  const { url } = await start(handler, { TRUST_PROXY: 'loopback' })
  const invalid = await fetch(url + '/api/download?secret=query', {
    headers: { 'x-real-ip': '192.0.2.1, 192.0.2.2' },
  })
  expect(invalid.status).toBe(400)
  expect(handler).not.toHaveBeenCalled()
  const failed = await fetch(url + '/api/download?secret=query')
  expect(failed.status).toBe(500)
  for (const response of [invalid, failed]) {
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('x-worker-version')).toBe(version.id)
    expect(response.headers.get('x-request-id')).toMatch(/^[\da-f-]{36}$/)
    expect(response.headers.get('access-control-expose-headers')).toContain('Retry-After')
    expect(await response.text()).not.toMatch(/PRIVATE|secret|query/)
  }
})

test.each([
  ['/api/parse', { MAX_CONCURRENT_PARSES: '1' }],
  ['/api/download', { MAX_CONCURRENT_DOWNLOADS: '1' }],
])(
  'global concurrency for %s remains held until the actual response stream completes',
  async (path, limits) => {
    const controllers = []
    const { url } = await start(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controllers.push(c)
              c.enqueue(new TextEncoder().encode('first\n'))
            },
          }),
        ),
      { ...limits, TRUST_PROXY: 'loopback' },
    )
    const responses = []
    try {
      const first = await fetch(url + path, { headers: { 'x-real-ip': '192.0.2.1' } })
      responses.push(first)
      const blocked = await fetch(url + path, { headers: { 'x-real-ip': '192.0.2.2' } })
      responses.push(blocked)
      expect(blocked.status).toBe(503)
      expect(blocked.headers.get('retry-after')).toBe('1')
      expect(blocked.headers.get('access-control-allow-origin')).toBe('*')
      expect((await blocked.json()).error.code).toBe('SERVER_BUSY')
      controllers.shift().close()
      expect(await first.text()).toBe('first\n')
      const next = await fetch(url + path)
      responses.push(next)
      expect(next.status).toBe(200)
    } finally {
      controllers.forEach((c) => {
        try {
          c.close()
        } catch {
          // A cancelled response may already have closed this fixture stream.
        }
      })
      await Promise.all(responses.map((r) => (r.bodyUsed ? undefined : r.body?.cancel())))
    }
  },
)

test('per-IP download concurrency cannot be bypassed by equivalent IPv6 forms', async () => {
  const controllers = []
  const { url } = await start(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controllers.push(c)
            c.enqueue(new Uint8Array([1]))
          },
        }),
      ),
    { MAX_DOWNLOADS_PER_IP: '1', MAX_CONCURRENT_DOWNLOADS: '2', TRUST_PROXY: 'loopback' },
  )
  const responses = []
  try {
    for (const [ip, expected] of [
      ['::ffff:c000:201', 200],
      ['192.0.2.1', 503],
      ['192.0.2.2', 200],
      ['192.0.2.3', 503],
    ]) {
      const response = await fetch(url + '/api/download', { headers: { 'x-real-ip': ip } })
      responses.push(response)
      expect(response.status).toBe(expected)
    }
  } finally {
    controllers.forEach((c) => {
      try {
        c.close()
      } catch {
        // A cancelled response may already have closed this fixture stream.
      }
    })
    await Promise.all(responses.map((r) => r.body?.cancel()))
  }
})

test('disconnect after a fully-read POST body aborts the handler signal', async () => {
  let signal
  let read = false
  const { url } = await start(async (request) => {
    expect(await request.text()).toBe('complete body')
    signal = request.signal
    read = true
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    return new Response(null, { status: 204 })
  })
  const request = http.request(url + '/api/parse', { method: 'POST', agent: false })
  request.on('error', () => {})
  request.end('complete body')
  try {
    await vi.waitFor(() => expect(read).toBe(true))
    expect(signal.aborted).toBe(false)
    request.destroy()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
  } finally {
    request.destroy()
  }
})

test('slow uploads expire and release capacity without timing out completed uploads', async () => {
  const { handleRequest } = await import('../backend/src/http/handle-request.ts')
  const slowSignals = []
  let completeSignal
  let completeBody
  let finishComplete
  const completion = new Promise((resolve) => {
    finishComplete = resolve
  })
  const { app, url } = await start(
    async (request, runtime, context) => {
      if (request.headers.get('x-fixture') === 'complete') {
        completeSignal = request.signal
        completeBody = await request.text()
        await completion
        return new Response(completeBody)
      }
      slowSignals.push(request.signal)
      return handleRequest(request, runtime, context)
    },
    { MAX_CONCURRENT_PARSES: '3', TRUST_PROXY: 'loopback' },
  )
  const requests = []
  const closed = []
  const responses = []
  const timeoutMs = app.server.requestTimeout
  const graceMs = app.server.connectionsCheckingInterval + 2000
  expect(timeoutMs).toBeGreaterThan(0)
  let trickle
  let complete
  let receiveDeadline
  try {
    // Exercise both declared lengths and chunked bodies over real HTTP. Neither
    // client stops sending, so an inactivity-only timeout would not fix this.
    for (const framing of [{ 'Content-Length': '1024' }, { 'Transfer-Encoding': 'chunked' }]) {
      const started = performance.now()
      const request = http.request(url + '/api/parse', {
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Real-IP': '192.0.2.1',
          ...framing,
        },
      })
      requests.push(request)
      closed.push(new Promise((resolve) => request.once('close', resolve)))
      responses.push(
        new Promise((resolve) => {
          let statusCode
          const finish = (error) =>
            resolve({ elapsedMs: performance.now() - started, statusCode, error })
          request.on('error', finish)
          request.once('response', (response) => {
            statusCode = response.statusCode
            response.on('error', finish)
            response.once('end', () => finish())
            response.resume()
          })
        }),
      )
      request.write('{"url":"')
    }
    // Bound both observable outcomes and actual connection closure. Accepting a
    // timeout reset must not let a hanging socket or missing deadline pass.
    const expired = Promise.race([
      Promise.all([Promise.all(responses), Promise.all(closed)]).then(([outcomes]) => outcomes),
      new Promise((_, reject) => {
        receiveDeadline = setTimeout(
          () => reject(new Error('Slow uploads did not close within their receive deadline')),
          timeoutMs + graceMs,
        )
      }),
    ])
    void expired.catch(() => {})
    let pulses = 0
    trickle = setInterval(() => {
      pulses++
      for (const request of requests) if (!request.destroyed) request.write(' ')
    }, 250)
    complete = fetch(url + '/api/parse', {
      method: 'POST',
      headers: { 'X-Fixture': 'complete', 'X-Real-IP': '192.0.2.2' },
      body: 'already uploaded',
    })
    void complete.catch(() => {})
    await vi.waitFor(() => {
      expect(slowSignals).toHaveLength(2)
      expect(completeBody).toBe('already uploaded')
    })
    const otherClient = () =>
      fetch(url + '/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': '192.0.2.3' },
        body: '{}',
      })
    const busy = await otherClient()
    expect(busy.status).toBe(503)
    expect((await busy.json()).error.code).toBe('SERVER_BUSY')

    const outcomes = await expired
    clearTimeout(receiveDeadline)
    for (const outcome of outcomes) expectReceiveTimeout(outcome, timeoutMs, graceMs)
    expect(pulses).toBeGreaterThan(5)
    await vi.waitFor(() => expect(slowSignals.every((signal) => signal.aborted)).toBe(true))
    // The fully received request is still allowed to produce a long response.
    expect(completeSignal.aborted).toBe(false)
    // Check admission while that response still holds its slot, so the test
    // cannot pass just because finishing it releases unrelated capacity.
    const next = await otherClient()
    expect(next.status).toBe(400)
    expect((await next.json()).error.code).toBe('INVALID_INPUT')
    finishComplete()
    expect(await (await complete).text()).toBe('already uploaded')
  } finally {
    clearTimeout(receiveDeadline)
    clearInterval(trickle)
    for (const request of requests) request.destroy()
    finishComplete()
    await Promise.allSettled(responses)
    if (complete) await complete.then((response) => response.body?.cancel()).catch(() => {})
  }
}, 20_000)

test('download cancellation cancels the upstream body and releases per-IP capacity', async () => {
  const cancelled = vi.fn()
  let signal
  let calls = 0
  const { url } = await start(
    async (request) => {
      signal = request.signal
      if (++calls > 1) return new Response('next')
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]))
          },
          cancel: cancelled,
        }),
      )
    },
    { MAX_DOWNLOADS_PER_IP: '1' },
  )
  const request = http.get(url + '/api/download', { agent: false })
  request.on('error', () => {})
  await new Promise((resolve) =>
    request.on('response', (response) => {
      response.once('data', () => {
        response.destroy()
        resolve()
      })
      response.on('error', () => {})
    }),
  )
  await vi.waitFor(() => {
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true)
  })
  expect(await (await fetch(url + '/api/download')).text()).toBe('next')
})

test('stream errors terminate the connection without logging or appending upstream secrets', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  let streamController
  const { url } = await start(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            streamController = c
            c.enqueue(new TextEncoder().encode('prefix'))
          },
        }),
      ),
  )
  const request = http.get(url + '/api/download?private=query', { agent: false })
  request.on('error', () => {})
  let body = ''
  await new Promise((resolve) =>
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        body += chunk
        streamController.error(Error('PRIVATE_UPSTREAM?token=secret'))
      })
      response.on('error', () => {})
      response.on('close', resolve)
    }),
  )
  expect(body).toBe('prefix')
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain('PRIVATE')
  expect(errorLog).not.toHaveBeenCalled()
})

test('adapter identity and capacity errors preserve native download iframe reporting and API diagnostics', async () => {
  const token = '22222222-2222-4222-8222-222222222222'
  let controller
  const { url } = await start(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            controller = c
            c.enqueue(new Uint8Array([1]))
          },
        }),
      ),
    { TRUST_PROXY: 'loopback', MAX_DOWNLOADS_PER_IP: '1' },
  )
  const first = await fetch(url + '/api/download')
  try {
    for (const [headers, status] of [
      [{}, 503],
      [{ 'x-real-ip': 'invalid' }, 400],
    ]) {
      const response = await fetch(url + '/api/download?errorToken=' + token, { headers })
      expect(response.status).toBe(status)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('x-api-version')).toBe(version.id)
      expect(response.headers.get('x-api-runtime')).toBe('node')
      const html = await response.text()
      expect(html).toContain('parent.postMessage(')
      expect(html).toContain('video-parser-download-error')
      expect(html).toContain(token)
      expect(html).toContain(response.headers.get('x-request-id'))
      if (status === 503) expect(html).toContain('"retryAfter":"1"')
    }
    const invalidToken = await fetch(url + '/api/download?errorToken=invalid')
    expect(invalidToken.headers.get('content-type')).toContain('application/json')
    await invalidToken.body.cancel()
  } finally {
    controller.close()
    await first.body.cancel()
  }
})

test('shutdown stops admission, drains until deadline, then aborts handlers and cancels streams', async () => {
  let signal
  const cancelled = vi.fn()
  const { app, url } = await start(
    async (request) => {
      signal = request.signal
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]))
          },
          cancel: cancelled,
        }),
      )
    },
    { SHUTDOWN_TIMEOUT_MS: '80' },
  )
  const response = await fetch(url + '/api/download')
  const started = performance.now()
  const closed = app.shutdown()
  expect(app.shutdown()).toBe(closed)
  expect(app.server.listening).toBe(false)
  expect(signal.aborted).toBe(false)
  await expect(fetch(url + '/api/health')).rejects.toThrow()
  await closed
  expect(performance.now() - started).toBeGreaterThanOrEqual(60)
  expect(performance.now() - started).toBeLessThan(1000)
  await vi.waitFor(() => {
    expect(signal.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
  await response.body.cancel().catch(() => {})
})

test('shutdown allows a response to finish without aborting its signal', async () => {
  let controller
  let signal
  const { app, url } = await start(
    async (request) => {
      signal = request.signal
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c
            c.enqueue(new Uint8Array([1]))
          },
        }),
      )
    },
    { SHUTDOWN_TIMEOUT_MS: '500' },
  )
  const response = await fetch(url + '/api/download')
  const closed = app.shutdown()
  controller.close()
  expect(await response.arrayBuffer()).toHaveProperty('byteLength', 1)
  await closed
  expect(signal.aborted).toBe(false)
})

test('real HTTP adapter keeps native globals, shares one runtime and validates per-connection identity', async () => {
  const native = { Request, Response, fetch }
  const runtimes = []
  const { url, app } = await start(async (_request, runtime, context) => {
    runtimes.push(runtime)
    return Response.json({
      clientId: context.clientId,
      limit: await runtime.rateLimit('parse', context.clientId),
    })
  })
  expect(app.server.listening).toBe(true)
  for (let i = 0; i < 11; i++) {
    const response = await fetch(url + '/api/parse', {
      headers: { 'x-real-ip': `192.0.2.${i}`, 'x-forwarded-for': '198.51.100.1' },
    })
    expect(await response.json()).toEqual({
      clientId: '127.0.0.1',
      limit: i < 10 ? { status: 'allowed' } : { status: 'limited', retryAfter: 60 },
    })
  }
  expect(new Set(runtimes).size).toBe(1)
  expect({ Request, Response, fetch }).toEqual(native)
})
