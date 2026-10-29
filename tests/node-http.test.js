import http from 'node:http'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { handleRequest } from '../backend/src/http/handle-request'
import { readConfig } from '../server/src/config'
import { createApiServer } from '../server/src/server'

const nativeFetch = globalThis.fetch
const sourceId = '7690537093143539065'
const source = `https://www.douyin.com/video/${sourceId}`
const media = 'https://v.douyinvod.com/offline.mp4'
const version = {
  runtime: 'node',
  id: '11111111-1111-4111-8111-111111111111',
  tag: 'a'.repeat(40),
  timestamp: '2026-01-01T00:00:00.000Z',
}
const allowedHosts = new Set([
  'www.douyin.com',
  'v.douyin.com',
  'm.douyin.com',
  'www.iesdouyin.com',
  'api5-normal-c-hl.amemv.com',
  'aweme.snssdk.com',
  'v.douyinvod.com',
])

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sendJson(response, item = { video: { play_addr: { url_list: [media] } } }) {
  const body = JSON.stringify({
    aweme_detail: {
      aweme_id: sourceId,
      desc: 'offline Node HTTP fixture',
      author: { nickname: 'fixture author' },
      ...item,
    },
  })
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

function encodeInput(data, contentType) {
  return contentType === 'application/json'
    ? JSON.stringify(data)
    : new URLSearchParams(data).toString()
}

function parseOptions(url = source, contentType = 'application/json', accept = 'application/json') {
  return {
    method: 'POST',
    headers: { 'Content-Type': contentType, Accept: accept },
    body: encodeInput({ url }, contentType),
  }
}

function downloadPath(url = media) {
  return '/api/download?url=' + encodeURIComponent(url) + '&filename=fixture.mp4'
}

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for HTTP progress')), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function* ndjson(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await within(reader.read())
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line) yield JSON.parse(line)
      }
    }
    expect(pending + decoder.decode()).toBe('')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function sendImage(response, complete) {
  sendJson(response, {
    images: [
      {
        uri: 'same-image',
        ...(complete
          ? { watermark_free_download_url_list: ['https://p.douyinpic.com/final.jpg'] }
          : { url_list: ['https://p.douyinpic.com/preview.jpg'] }),
      },
    ],
  })
}

function diagnostics(response) {
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i)
  expect(response.headers.get('x-worker-version')).toBe(version.id)
  expect(response.headers.get('x-api-version')).toBe(version.id)
  expect(response.headers.get('x-api-runtime')).toBe('node')
  for (const name of ['X-Request-ID', 'X-API-Version', 'X-API-Runtime']) {
    expect(response.headers.get('access-control-expose-headers')).toContain(name)
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    expect(response.headers.get('access-control-expose-headers')).toContain('Retry-After')
  }
}

// Real API and upstream TCP listeners, real shared parser/media service, real native
// fetch (including decompression). Only approved outbound HTTPS destinations are
// mapped to deterministic offline fixtures; there is NEVER a public-network fallback.
// API clients always use the saved nativeFetch, bypassing this outbound-only wrapper.
describe('shared core over real Node HTTP with an offline deterministic upstream', () => {
  let app, origin, fixture, fixtureOrigin, upstream
  let outbound, hits, blockedFetches, fixtureErrors
  beforeEach(async () => {
    outbound = []
    hits = []
    blockedFetches = []
    fixtureErrors = []
    upstream = (_request, response) => sendJson(response)
    fixture = http.createServer((request, response) => {
      hits.push({ path: request.url, headers: request.headers })
      Promise.resolve()
        .then(() => upstream(request, response))
        .catch((error) => {
          fixtureErrors.push(error)
          response.destroy()
        })
    })
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
    fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`
    vi.stubGlobal('fetch', async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      outbound.push({ url: request.url, headers: Object.fromEntries(request.headers) })
      if (
        url.protocol !== 'https:' ||
        !allowedHosts.has(url.hostname) ||
        url.port ||
        url.username ||
        url.password
      ) {
        blockedFetches.push(request.url)
        throw new Error('Offline test refuses unconfigured outbound destination')
      }
      return nativeFetch(new Request(fixtureOrigin + url.pathname + url.search, request))
    })
    app = createApiServer({
      handler: handleRequest,
      version,
      config: readConfig({
        MAX_CONCURRENT_PARSES: '1',
        MAX_CONCURRENT_DOWNLOADS: '1',
        MAX_DOWNLOADS_PER_IP: '1',
        SHUTDOWN_TIMEOUT_MS: '300',
      }),
      logger: vi.fn(),
    })
    const address = await app.listen(0)
    origin = `http://127.0.0.1:${address.port}`
  })
  afterEach(async () => {
    try {
      await app?.shutdown()
      if (fixture)
        await new Promise((resolve) => {
          fixture.close(resolve)
          fixture.closeAllConnections()
        })
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
    expect(fixtureErrors).toEqual([])
    expect(blockedFetches).toEqual([])
  })

  test('health exposes Node runtime, exact version metadata and CORS diagnostics', async () => {
    const response = await nativeFetch(origin + '/api/health', {
      headers: { Origin: 'https://frontend.test' },
    })
    expect(response.status).toBe(200)
    diagnostics(response)
    expect(await response.json()).toEqual({
      success: true,
      data: {
        service: 'video-parser-api',
        status: 'ok',
        runtime: 'node',
        version: version.id,
        versionTag: version.tag,
        versionCreatedAt: version.timestamp,
      },
    })
    expect(outbound).toEqual([])
  })

  test('preflight responds without contacting the parser upstream', async () => {
    const response = await nativeFetch(origin + '/api/parse', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://frontend.test',
        'Access-Control-Request-Headers': 'Content-Type, Range',
      },
    })
    expect(response.status).toBe(204)
    diagnostics(response)
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')).toContain('Range')
    expect(await response.text()).toBe('')
    expect(outbound).toEqual([])
  })

  test.each(['application/json', 'application/x-www-form-urlencoded'])(
    '%s traverses the real HTTP adapter, shared parser and native upstream fetch',
    async (contentType) => {
      const response = await nativeFetch(origin + '/api/parse', parseOptions(source, contentType))
      expect(response.status).toBe(200)
      diagnostics(response)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          platform: 'douyin',
          videoId: sourceId,
          title: 'offline Node HTTP fixture',
          author: 'fixture author',
          videoUrl: media,
          parseStatus: 'complete',
        },
      })
      expect(outbound).toHaveLength(1)
      expect(new URL(outbound[0].url).pathname).toBe('/aweme/v1/web/aweme/detail/')
      expect(hits).toHaveLength(1)
      expect(hits[0].path).toContain('aweme_id=' + sourceId)
    },
  )

  test.each(['application/json', 'application/x-www-form-urlencoded'])(
    '%s enforces 5000 characters independently of UTF-8 bytes',
    async (contentType) => {
      const input = '文'.repeat(100) + 'x'.repeat(5000 - source.length - 101) + ' ' + source
      expect(input).toHaveLength(5000)
      const accepted = await nativeFetch(origin + '/api/parse', parseOptions(input, contentType))
      expect(accepted.status).toBe(200)
      expect((await accepted.json()).success).toBe(true)
      const before = outbound.length
      const rejected = await nativeFetch(
        origin + '/api/parse',
        parseOptions('x' + input, contentType),
      )
      expect(rejected.status).toBe(413)
      diagnostics(rejected)
      expect((await rejected.json()).error.code).toBe('INPUT_TOO_LARGE')
      expect(outbound).toHaveLength(before)
    },
  )

  test.each(['application/json', 'application/x-www-form-urlencoded'])(
    '%s accepts exactly 32 KiB and rejects known-length and chunked excess bytes',
    async (contentType) => {
      const limit = 32 * 1024
      const base = encodeInput({ url: source, padding: '' }, contentType)
      const extra = limit - Buffer.byteLength(base)
      const padding = '文'.repeat(Math.floor(extra / 3)) + 'x'.repeat(extra % 3)
      const body =
        contentType === 'application/json'
          ? encodeInput({ url: source, padding }, contentType)
          : base + padding
      expect(Buffer.byteLength(body)).toBe(limit)
      expect(body.length).toBeLessThan(limit)
      const options = parseOptions(source, contentType)
      const accepted = await nativeFetch(origin + '/api/parse', { ...options, body })
      expect(accepted.status).toBe(200)
      expect((await accepted.json()).success).toBe(true)
      const before = outbound.length
      const bytes = Buffer.from(body + ' ')
      for (const chunked of [false, true]) {
        let incomingHeaders
        app.server.once('request', (request) => {
          incomingHeaders = request.headers
        })
        const rejected = await nativeFetch(origin + '/api/parse', {
          ...options,
          body: chunked
            ? new ReadableStream({
                start(controller) {
                  // Split through UTF-8 input; counting decoded characters is insufficient.
                  controller.enqueue(bytes.subarray(0, 16000))
                  controller.enqueue(bytes.subarray(16000))
                  controller.close()
                },
              })
            : bytes,
          ...(chunked ? { duplex: 'half' } : {}),
        })
        expect(rejected.status).toBe(413)
        diagnostics(rejected)
        expect((await rejected.json()).error.code).toBe('INPUT_TOO_LARGE')
        if (chunked) {
          expect(incomingHeaders['content-length']).toBeUndefined()
          expect(incomingHeaders['transfer-encoding']).toBe('chunked')
        } else expect(incomingHeaders['content-length']).toBe(String(limit + 1))
      }
      expect(outbound).toHaveLength(before)
    },
  )

  test.each([
    ['application/json', '{private invalid JSON', 400, 'INVALID_INPUT'],
    ['application/json', JSON.stringify({ url: 'not a URL' }), 400, 'INVALID_URL'],
    [
      'application/json',
      JSON.stringify({ url: 'http://www.douyin.com/video/1' }),
      400,
      'INVALID_URL',
    ],
    [
      'application/json',
      JSON.stringify({ url: 'https://example.com/private' }),
      400,
      'UNSUPPORTED_PLATFORM',
    ],
    ['application/json', JSON.stringify({ url: '' }), 400, 'INVALID_INPUT'],
    ['application/x-www-form-urlencoded', 'url=a&url=b', 400, 'INVALID_INPUT'],
    ['text/plain', source, 415, 'INVALID_CONTENT_TYPE'],
  ])(
    'invalid %s body %s fails as CORS JSON before opening NDJSON',
    async (type, body, status, code) => {
      const response = await nativeFetch(origin + '/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': type, Accept: 'application/x-ndjson' },
        body,
      })
      expect(response.status).toBe(status)
      diagnostics(response)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({ success: false, error: { code } })
      expect(outbound).toEqual([])
      expect(hits).toEqual([])
    },
  )

  test('NDJSON preview arrives on the client before the completion gate opens, followed by one result', async () => {
    const completion = deferred()
    const waiting = deferred()
    let completed = false
    upstream = async (request, response) => {
      if (request.url.includes('/web/aweme/detail/')) return sendImage(response, false)
      waiting.resolve()
      await completion.promise
      if (!response.destroyed) sendImage(response, true)
    }
    let events
    try {
      const response = await within(
        nativeFetch(
          origin + '/api/parse',
          parseOptions(source, 'application/json', 'application/x-ndjson'),
        ),
      )
      expect(response.status).toBe(200)
      diagnostics(response)
      expect(response.headers.get('content-type')).toContain('application/x-ndjson')
      expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
      events = ndjson(response)
      const first = await events.next()
      expect(first.value).toMatchObject({
        type: 'preview',
        data: { images: [{ watermarkFree: false }] },
      })
      expect(first.value.data).not.toHaveProperty('parseStatus')
      await within(waiting.promise)
      expect(completed).toBe(false)
      // A buffered implementation cannot reach this gate-unlock from a socket read.
      completed = true
      completion.resolve()
      const rest = []
      for await (const event of events) rest.push(event)
      expect(rest.filter((event) => event.type === 'result')).toHaveLength(1)
      expect(rest.at(-1)).toMatchObject({
        type: 'result',
        data: {
          parseStatus: 'complete',
          images: [
            {
              url: 'https://p.douyinpic.com/final.jpg',
              watermarkFree: true,
            },
          ],
        },
      })
      expect(rest.some((event) => event.type === 'error')).toBe(false)
    } finally {
      completion.resolve()
      await events?.return()
    }
  })

  test('parser failure after NDJSON opens is an error event, not JSON or a result', async () => {
    upstream = (_request, response) => {
      response.writeHead(503, { 'Content-Type': 'text/plain' })
      response.end('PRIVATE_UPSTREAM_FAILURE')
    }
    const response = await nativeFetch(
      origin + '/api/parse',
      parseOptions(source, 'application/json', 'application/x-ndjson'),
    )
    expect(response.status).toBe(200)
    diagnostics(response)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    const events = []
    for await (const event of ndjson(response)) events.push(event)
    expect(events).toEqual([
      {
        type: 'error',
        error: { code: 'VIDEO_RESOURCE_NOT_FOUND', message: expect.any(String) },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('PRIVATE_UPSTREAM_FAILURE')
    expect(hits.length).toBeGreaterThan(0)
  })

  test.each([200, 206])(
    'HTTP %s media preserves exact binary bytes and honest length/range framing',
    async (status) => {
      const bytes = Buffer.from([0, 128, 255, 1])
      upstream = (_request, response) => {
        response.writeHead(status, {
          'Content-Type': 'video/mp4',
          'Content-Length': bytes.length,
          'Content-Encoding': 'identity',
          'Accept-Ranges': 'bytes',
          ...(status === 206 ? { 'Content-Range': 'bytes 2-5/10' } : {}),
        })
        response.end(bytes)
      }
      const response = await nativeFetch(origin + downloadPath(), {
        headers: status === 206 ? { Range: 'bytes=2-5' } : {},
      })
      expect(response.status).toBe(status)
      diagnostics(response)
      expect(response.headers.get('content-type')).toBe('video/mp4')
      expect(response.headers.get('content-disposition')).toContain('attachment')
      expect(response.headers.get('content-length')).toBe(String(bytes.length))
      expect(response.headers.get('transfer-encoding')).toBeNull()
      expect(response.headers.get('content-range')).toBe(status === 206 ? 'bytes 2-5/10' : null)
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(response.headers.get('access-control-expose-headers')).toContain('Content-Range')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
      expect(hits).toHaveLength(1)
      expect(hits[0].headers.range).toBe(status === 206 ? 'bytes=2-5' : undefined)
      expect(outbound[0].headers['accept-encoding']).toBe('identity')
      // Native fetch appends another identity token for Range; no compression is allowed.
      expect(hits[0].headers['accept-encoding']).toMatch(/^identity(?:,\s*identity)*$/)
    },
  )

  test('416 preserves unsatisfied range without forwarding an upstream error as media', async () => {
    const body = 'PRIVATE_RANGE_ERROR'
    upstream = (_request, response) => {
      response.writeHead(416, {
        'Content-Type': 'text/html',
        'Content-Length': Buffer.byteLength(body),
        'Content-Range': 'bytes */10',
        'Accept-Ranges': 'bytes',
      })
      response.end(body)
    }
    const response = await nativeFetch(origin + downloadPath(), { headers: { Range: 'bytes=99-' } })
    expect(response.status).toBe(416)
    diagnostics(response)
    expect(response.headers.get('content-range')).toBe('bytes */10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-disposition')).toBeNull()
    expect(response.headers.get('content-type')).toBeNull()
    expect([null, '0']).toContain(response.headers.get('content-length'))
    expect(await response.text()).toBe('')
    expect(hits).toHaveLength(1)
    expect(hits[0].headers.range).toBe('bytes=99-')
    expect(outbound[0].headers['accept-encoding']).toBe('identity')
    // Native fetch appends another identity token for Range; no compression is allowed.
    expect(hits[0].headers['accept-encoding']).toMatch(/^identity(?:,\s*identity)*$/)
  })

  test.each([200, 206])(
    'real gzip HTTP %s is rejected with 502 despite native fetch decoding its body',
    async (status) => {
      const bytes = Buffer.from([0, 128, 255, 1])
      const compressed = gzipSync(bytes)
      upstream = (_request, response) => {
        response.writeHead(status, {
          'Content-Type': 'video/mp4',
          'Content-Encoding': 'gzip',
          'Content-Length': compressed.length,
          ...(status === 206
            ? { 'Content-Range': `bytes 0-${compressed.length - 1}/${compressed.length}` }
            : {}),
        })
        response.end(compressed)
      }
      // Prove this is the native Node hazard, not a fabricated Response: actual HTTP
      // gzip bytes are decoded while the encoded Content-Length/Range remain intact.
      const probe = await nativeFetch(fixtureOrigin + '/encoding-probe', {
        headers: { 'Accept-Encoding': 'identity' },
      })
      expect(probe.headers.get('content-encoding')).toBe('gzip')
      expect(probe.headers.get('content-length')).toBe(String(compressed.length))
      expect(probe.headers.get('content-range')).toBe(
        status === 206 ? `bytes 0-${compressed.length - 1}/${compressed.length}` : null,
      )
      expect(Buffer.from(await probe.arrayBuffer())).toEqual(bytes)
      expect(compressed.length).not.toBe(bytes.length)
      const response = await nativeFetch(origin + downloadPath(), {
        headers: status === 206 ? { Range: `bytes=0-${compressed.length - 1}` } : {},
      })
      expect(response.status).toBe(502)
      diagnostics(response)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('content-disposition')).toBeNull()
      expect(response.headers.get('content-range')).toBeNull()
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'DOWNLOAD_FAILED' },
      })
      expect(outbound).toHaveLength(1)
      expect(hits).toHaveLength(2)
      expect(outbound[0].headers['accept-encoding']).toBe('identity')
      expect(hits[1].headers['accept-encoding']).toMatch(/^identity(?:,\s*identity)*$/)
    },
  )

  test.each([
    ['', 'INVALID_INPUT'],
    ['not a URL', 'INVALID_URL'],
    ['http://v.douyinvod.com/video.mp4', 'INVALID_URL'],
    ['https://v.douyinvod.com.evil.test/video.mp4', 'INVALID_URL'],
    ['https://user:pass@v.douyinvod.com/video.mp4', 'INVALID_URL'],
  ])('invalid download URL %s is rejected before outbound fetch', async (url, code) => {
    const response = await nativeFetch(origin + downloadPath(url))
    expect(response.status).toBe(400)
    diagnostics(response)
    expect(await response.json()).toMatchObject({ success: false, error: { code } })
    expect(outbound).toEqual([])
    expect(hits).toEqual([])
  })

  test.each(
    ['download', 'share'].flatMap((operation) => [
      [operation, 'http-loopback'],
      [operation, 'https://127.0.0.1/internal-must-not-be-requested'],
      [operation, 'https://www.douyin.com.evil.test/internal-must-not-be-requested'],
    ]),
  )('%s redirect rejects %s before making that request', async (operation, target) => {
    upstream = (_request, response) => {
      response.writeHead(302, {
        Location:
          target === 'http-loopback' ? fixtureOrigin + '/internal-must-not-be-requested' : target,
      })
      response.end('PRIVATE_REDIRECT_BODY')
    }
    const response = await nativeFetch(
      origin + (operation === 'download' ? downloadPath() : '/api/parse'),
      operation === 'download' ? {} : parseOptions('https://v.douyin.com/offline-share/'),
    )
    expect(response.status).toBe(400)
    diagnostics(response)
    const code =
      operation === 'share' && target !== 'http-loopback' ? 'UNSUPPORTED_PLATFORM' : 'INVALID_URL'
    expect(await response.json()).toMatchObject({ success: false, error: { code } })
    expect(outbound).toHaveLength(1)
    expect(hits).toHaveLength(1)
    expect(hits.some((hit) => hit.path.includes('/internal-must-not-be-requested'))).toBe(false)
    expect(blockedFetches).toEqual([]) // Core rejected it; the test network guard did not.
  })

  test('an allowlisted media redirect preserves Range and identity on both real HTTP hops', async () => {
    const bytes = Buffer.from([0, 128, 255, 1])
    upstream = (request, response) => {
      if (request.url === '/offline.mp4') {
        response.writeHead(302, { Location: 'https://v.douyinvod.com/final.mp4' })
        return response.end()
      }
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': bytes.length,
        'Content-Range': 'bytes 2-5/10',
      })
      response.end(bytes)
    }
    const response = await nativeFetch(origin + downloadPath(), { headers: { Range: 'bytes=2-5' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(hits.map((hit) => hit.path)).toEqual(['/offline.mp4', '/final.mp4'])
    for (const hit of hits) {
      expect(hit.headers.range).toBe('bytes=2-5')
      expect(hit.headers['accept-encoding']).toMatch(/^identity(?:,\s*identity)*$/)
    }
  })

  test('a long real HTTP media stream sends its first bytes before the upstream ends', async () => {
    const completion = deferred()
    const prefix = Buffer.from([0, 128, 255, 1])
    const tail = Buffer.alloc(1024 * 1024, 42)
    let upstreamEnded = false
    upstream = async (_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': prefix.length + tail.length,
      })
      response.write(prefix)
      await completion.promise
      if (!response.destroyed) {
        upstreamEnded = true
        response.end(tail)
      }
    }
    let reader
    try {
      const response = await within(nativeFetch(origin + downloadPath()))
      expect(response.status).toBe(200)
      reader = response.body.getReader()
      const first = await within(reader.read())
      expect(first.done).toBe(false)
      expect(Buffer.from(first.value)).toEqual(prefix)
      expect(upstreamEnded).toBe(false)
      completion.resolve()
      const chunks = []
      while (true) {
        const { done, value } = await within(reader.read())
        if (done) break
        chunks.push(Buffer.from(value))
      }
      expect(Buffer.concat(chunks)).toEqual(tail)
      expect(upstreamEnded).toBe(true)
    } finally {
      completion.resolve()
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
  })

  test('download disconnect closes the real upstream socket and releases global/per-IP capacity', async () => {
    const closed = deferred()
    let upstreamResponse, upstreamSocket
    upstream = (request, response) => {
      upstreamResponse = response
      upstreamSocket = request.socket
      request.socket.once('close', closed.resolve)
      response.writeHead(200, { 'Content-Type': 'video/mp4' })
      response.write(Buffer.from([0, 128, 255, 1]))
      // Intentionally never end: only client cancellation can close this socket.
    }
    const firstChunk = deferred()
    let downstream
    const client = http.get(origin + downloadPath(), { agent: false }, (response) => {
      downstream = response
      response.once('data', firstChunk.resolve)
      response.on('error', () => {})
    })
    client.on('error', () => {})
    try {
      expect(await within(firstChunk.promise)).toEqual(Buffer.from([0, 128, 255, 1]))
      expect(upstreamResponse.writableEnded).toBe(false)
      const busy = await nativeFetch(origin + downloadPath())
      expect(busy.status).toBe(503)
      expect(busy.headers.get('retry-after')).toBe('1')
      diagnostics(busy)
      expect((await busy.json()).error.code).toBe('SERVER_BUSY')
      expect(hits).toHaveLength(1)
      downstream.destroy()
      client.destroy()
      await within(closed.promise)
      expect(upstreamSocket.destroyed).toBe(true)
      expect(upstreamResponse.writableEnded).toBe(false)
      upstream = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '4' })
        response.end('next')
      }
      const next = await nativeFetch(origin + downloadPath())
      expect(next.status).toBe(200)
      expect(await next.text()).toBe('next')
      expect(hits).toHaveLength(2)
    } finally {
      downstream?.destroy()
      client.destroy()
    }
  })

  test.each(['application/json', 'application/x-ndjson'])(
    '%s disconnect after POST input reaches core cancels in-flight native upstream reads',
    async (accept) => {
      const entered = deferred()
      const preview = deferred()
      const inFlight = []
      let downstream,
        responseStarted = false
      upstream = (request, response) => {
        if (accept === 'application/x-ndjson' && request.url.includes('/web/aweme/detail/')) {
          return sendImage(response, false)
        }
        inFlight.push({ socket: request.socket, response })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.write('{"aweme_detail":')
        entered.resolve()
      }
      const options = parseOptions(source, 'application/json', accept)
      const client = http.request(
        origin + '/api/parse',
        {
          method: options.method,
          headers: options.headers,
          agent: false,
        },
        (response) => {
          downstream = response
          responseStarted = true
          let pending = ''
          response.on('data', (chunk) => {
            pending += chunk
            if (pending.includes('\n')) preview.resolve(pending.slice(0, pending.indexOf('\n')))
          })
          response.on('error', () => {})
        },
      )
      client.on('error', () => {})
      client.end(options.body)
      try {
        await within(entered.promise) // Core has parsed the fully submitted POST body.
        if (accept === 'application/x-ndjson') {
          expect(JSON.parse(await within(preview.promise))).toMatchObject({ type: 'preview' })
          expect(downstream.statusCode).toBe(200)
        } else expect(responseStarted).toBe(false)
        const before = outbound.length
        const busy = await nativeFetch(origin + '/api/parse', parseOptions())
        expect(busy.status).toBe(503)
        expect((await busy.json()).error.code).toBe('SERVER_BUSY')
        downstream?.destroy()
        client.destroy()
        await vi.waitFor(
          () => {
            expect(inFlight.length).toBeGreaterThan(0)
            for (const { socket, response } of inFlight) {
              expect(socket.destroyed).toBe(true)
              expect(response.destroyed).toBe(true)
              expect(response.writableEnded).toBe(false)
            }
          },
          { timeout: 2000, interval: 10 },
        )
        // Let the 600ms strategy-launch interval pass: cancelled work must not retry.
        await delay(650)
        expect(outbound).toHaveLength(before)
        upstream = (_request, response) => sendJson(response)
        const next = await nativeFetch(origin + '/api/parse', parseOptions())
        expect(next.status).toBe(200)
        expect((await next.json()).data.videoId).toBe(sourceId)
      } finally {
        downstream?.destroy()
        client.destroy()
      }
    },
  )
})

// This one adapter-only probe makes source pulls observable; all protocol cases
// above use handleRequest and actual native-fetch upstream HTTP bodies instead.
test('a paused socket bounds adapter stream pulls and resumes them only with downstream demand', async () => {
  const chunk = new Uint8Array(64 * 1024)
  const maxChunks = 1024 // Finite safety cap prevents a broken adapter from exhausting memory.
  const cancelled = vi.fn()
  let pulls = 0
  const app = createApiServer({
    version,
    config: readConfig({ SHUTDOWN_TIMEOUT_MS: '300' }),
    logger: vi.fn(),
    handler: async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++
              controller.enqueue(chunk)
              if (pulls === maxChunks) controller.close()
            },
            cancel: cancelled,
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'Content-Type': 'application/octet-stream' } },
      ),
  })
  let client, downstream
  try {
    const address = await app.listen(0)
    downstream = await within(
      new Promise((resolve, reject) => {
        client = http.get(
          `http://127.0.0.1:${address.port}/api/download`,
          { agent: false },
          (response) => {
            response.pause()
            response.on('error', () => {})
            resolve(response)
          },
        )
        client.on('error', reject)
      }),
    )
    expect(downstream.statusCode).toBe(200)
    await delay(200)
    const paused = pulls
    expect(paused).toBeGreaterThan(0)
    // Allow kernel/Hono queues, not an entire 64MiB response buffered in JS.
    expect(paused * chunk.byteLength).toBeLessThan(16 * 1024 * 1024)
    await delay(150)
    expect(pulls).toBe(paused)
    let consumed = 0
    downstream.on('data', (bytes) => {
      consumed += bytes.length
      if (consumed >= 4 * 1024 * 1024) downstream.pause()
    })
    downstream.resume()
    await vi.waitFor(() => expect(pulls).toBeGreaterThan(paused), { timeout: 2000, interval: 10 })
    downstream.pause()
    downstream.destroy()
    client.destroy()
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
    const afterCancel = pulls
    await delay(50)
    expect(pulls).toBe(afterCancel)
  } finally {
    downstream?.destroy()
    client?.destroy()
    await app.shutdown()
  }
})
