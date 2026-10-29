import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { build } from 'esbuild'
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const execFileAsync = promisify(execFile)

test('the Worker boundary check really bundles the production entry for browsers', async () => {
  const result = await execFileAsync(process.execPath, ['scripts/check-worker-build.mjs'], {
    cwd: root,
    timeout: 30000,
  }).catch((error) => error)
  expect(result.code, result.stderr).toBeUndefined()
  expect(result.stdout).toContain('Worker browser build verified')
  expect(result.stdout).toContain('Wrangler dry-run verified')
}, 35000)

test('the build check rejects browser-compatible server code and Node builtins', async () => {
  const { checkWorkerBuild } = await import('../scripts/check-worker-build.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'video-parser-boundary-test-'))
  try {
    await mkdir(join(directory, 'server/src'), { recursive: true })
    await writeFile(join(directory, 'server/src/value.js'), 'export const value = 1')
    await writeFile(join(directory, 'entry.js'), "export { value } from './server/src/value.js'")
    await expect(checkWorkerBuild({ root: directory, entryPoint: 'entry.js' })).rejects.toThrow(
      'server/src boundary',
    )
    await writeFile(join(directory, 'entry.js'), "export { readFile } from 'node:fs'")
    await expect(checkWorkerBuild({ root: directory, entryPoint: 'entry.js' })).rejects.toThrow(
      /node:fs/,
    )
    await writeFile(join(directory, 'entry.js'), "export { readFile } from 'fs'")
    await expect(checkWorkerBuild({ root: directory, entryPoint: 'entry.js' })).rejects.toThrow(
      /"fs"/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function bundle(entryPoint) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function* ndjson(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line) yield JSON.parse(line)
      }
    }
    pending += decoder.decode()
    expect(pending).toBe('')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const origin = 'https://worker.test'
const source = 'https://www.douyin.com/video/7690537093143539065'
const media = 'https://v.douyinvod.com/offline.mp4'
const sourceId = '7690537093143539065'
const requests = []
let upstream = () => new Response('unconfigured offline upstream', { status: 503 })

function parseRequest(url = source, contentType = 'application/json', extra = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body:
      contentType === 'application/json'
        ? JSON.stringify({ url })
        : new URLSearchParams({ url }).toString(),
    ...extra,
  }
}

function offlineOptions(script, name) {
  return {
    name,
    script,
    modules: true,
    compatibilityDate: '2026-09-21',
    // Every outbound fetch is intercepted; there is no real Douyin fallback.
    outboundService: async (request) => {
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers) })
      return upstream(request)
    },
  }
}

describe('real workerd production adapter', () => {
  let mf
  let unbound
  beforeAll(async () => {
    const script = await bundle('worker/src/index.ts')
    mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        log: new Log(LogLevel.ERROR),
        workers: [
          {
            ...offlineOptions(script, 'production'),
            versionMetadata: 'CF_VERSION_METADATA',
            ratelimits: {
              PARSE_RATE_LIMITER: { namespace_id: '1001', simple: { limit: 2, period: 60 } },
              DOWNLOAD_RATE_LIMITER: { namespace_id: '1002', simple: { limit: 2, period: 60 } },
            },
          },
          offlineOptions(script, 'unbound'),
        ],
      }),
    )
    await mf.ready
    unbound = await mf.getWorker('unbound')
  }, 30000)
  afterAll(async () => {
    await mf?.dispose()
  }, 15000)

  test('production entry health identifies Cloudflare and exposes CORS diagnostics', async () => {
    const response = await mf.dispatchFetch(origin + '/api/health')
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/i)
    const result = await response.json()
    expect(result).toMatchObject({
      success: true,
      data: { runtime: 'cloudflare-worker', status: 'ok' },
    })
    expect(response.headers.get('X-Worker-Version')).toBe(result.data.version)
    expect(result.data.version).not.toBe('unknown')
  })

  test('real rate-limit bindings isolate operations and ignore spoofed X-Forwarded-For', async () => {
    const before = requests.length
    for (let index = 0; index < 3; index++) {
      const response = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest('', 'application/json', {
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.10',
            'X-Forwarded-For': `198.51.100.${index}`,
          },
        }),
      )
      expect(response.status).toBe(index < 2 ? 400 : 429)
      if (index === 2) {
        expect(response.headers.get('Retry-After')).toBe('60')
        expect((await response.json()).error.code).toBe('RATE_LIMITED')
      } else await response.arrayBuffer()
    }
    const independent = await mf.dispatchFetch(origin + '/api/download', {
      headers: { 'CF-Connecting-IP': '192.0.2.10' },
    })
    expect(independent.status).toBe(400)
    await independent.arrayBuffer()
    expect(requests.length).toBe(before)
  })

  test('missing production bindings fail closed before any upstream request', async () => {
    const before = requests.length
    for (const [path, options] of [
      ['/api/parse', parseRequest()],
      ['/api/download?url=' + encodeURIComponent(media), {}],
    ]) {
      const response = await unbound.fetch(origin + path, options)
      expect(response.status).toBe(503)
      expect((await response.json()).error.code).toBe('SERVICE_UNAVAILABLE')
    }
    expect(requests.length).toBe(before)
  })
})

// These protocol tests execute the shared core inside workerd, not the production
// entry. Only its limiter/version are fixtures; parser, HTTP and media code are real.
describe('shared core in real workerd with an offline upstream', () => {
  let mf
  beforeAll(async () => {
    const script = await bundle('tests/fixtures/worker-runtime.ts')
    mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        log: new Log(LogLevel.ERROR),
        ...offlineOptions(script, 'fixture'),
      }),
    )
    await mf.ready
  }, 30000)
  afterAll(async () => {
    await mf?.dispose()
  }, 15000)
  beforeEach(() => {
    requests.length = 0
    upstream = () =>
      Response.json({
        aweme_detail: {
          aweme_id: sourceId,
          desc: 'offline workerd fixture',
          author: { nickname: 'fixture author' },
          video: { play_addr: { url_list: [media] } },
        },
      })
  })

  test('fixture identifies its runtime without pretending to be the production entry', async () => {
    const response = await mf.dispatchFetch(origin + '/api/health')
    expect(await response.json()).toMatchObject({
      success: true,
      data: { runtime: 'cloudflare-worker', version: 'workerd-core-fixture' },
    })
  })

  test('preflight is handled without invoking a parser or contacting the upstream', async () => {
    const response = await mf.dispatchFetch(origin + '/api/parse', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://frontend.test',
        'Access-Control-Request-Headers': 'Content-Type, Range',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Range')
    expect(await response.text()).toBe('')
    expect(requests).toHaveLength(0)
  })

  test.each(['application/json', 'application/x-www-form-urlencoded'])(
    '%s input runs the real parser against an offline HTTP response',
    async (contentType) => {
      const response = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest(source, contentType),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('application/json')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          platform: 'douyin',
          videoId: sourceId,
          title: 'offline workerd fixture',
          videoUrl: media,
        },
      })
      expect(requests).toHaveLength(1)
      expect(new URL(requests[0].url).pathname).toBe('/aweme/v1/web/aweme/detail/')
    },
  )

  test.each(['application/json', 'application/x-www-form-urlencoded'])(
    '%s enforces the exact 5000-character boundary before fetch',
    async (contentType) => {
      const input = 'x'.repeat(5000 - source.length - 1) + ' ' + source
      const accepted = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest(input, contentType),
      )
      expect(accepted.status).toBe(200)
      expect((await accepted.json()).success).toBe(true)
      const before = requests.length
      const rejected = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest('文' + input, contentType),
      )
      expect(rejected.status).toBe(413)
      expect((await rejected.json()).error.code).toBe('INPUT_TOO_LARGE')
      expect(requests.length).toBe(before)
    },
  )

  test.each(['application/json', 'application/x-www-form-urlencoded'])(
    '%s accepts exactly 32 KiB but rejects a chunked byte over the limit',
    async (contentType) => {
      const base =
        contentType === 'application/json'
          ? JSON.stringify({ url: source, padding: '' })
          : new URLSearchParams({ url: source, padding: '' }).toString()
      const padding = 'x'.repeat(32 * 1024 - Buffer.byteLength(base))
      const body =
        contentType === 'application/json'
          ? JSON.stringify({ url: source, padding })
          : new URLSearchParams({ url: source, padding }).toString()
      expect(Buffer.byteLength(body)).toBe(32 * 1024)
      const accepted = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest(source, contentType, { body }),
      )
      expect(accepted.status).toBe(200)
      await accepted.arrayBuffer()
      const before = requests.length
      const bytes = new TextEncoder().encode(body + ' ')
      const chunked = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 16000))
          controller.enqueue(bytes.slice(16000))
          controller.close()
        },
      })
      const rejected = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest(source, contentType, { body: chunked, duplex: 'half' }),
      )
      expect(rejected.status).toBe(413)
      expect((await rejected.json()).error.code).toBe('INPUT_TOO_LARGE')
      expect(requests.length).toBe(before)
    },
  )

  test.each([
    ['application/json', '{private invalid JSON', 400, 'INVALID_INPUT'],
    [
      'application/json',
      JSON.stringify({ url: 'https://example.com/private' }),
      400,
      'UNSUPPORTED_PLATFORM',
    ],
    ['application/x-www-form-urlencoded', 'url=a&url=b', 400, 'INVALID_INPUT'],
    ['text/plain', source, 415, 'INVALID_CONTENT_TYPE'],
  ])(
    'invalid %s input returns an ordinary error before opening NDJSON',
    async (contentType, body, status, code) => {
      const response = await mf.dispatchFetch(origin + '/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': contentType, Accept: 'application/x-ndjson' },
        body,
      })
      expect(response.status).toBe(status)
      expect(response.headers.get('Content-Type')).toContain('application/json')
      expect(await response.json()).toMatchObject({ success: false, error: { code } })
      expect(requests).toHaveLength(0)
    },
  )

  test('NDJSON delivers a preview over workerd before the upstream can finish', async () => {
    const completion = deferred()
    upstream = async (request) => {
      const primary = new URL(request.url).pathname.includes('/web/aweme/detail/')
      if (!primary) await completion.promise
      return Response.json({
        aweme_detail: {
          aweme_id: sourceId,
          desc: 'incremental fixture',
          images: [
            {
              uri: 'same-image',
              ...(primary
                ? { url_list: ['https://p.douyinpic.com/preview.jpg'] }
                : { watermark_free_download_url_list: ['https://p.douyinpic.com/final.jpg'] }),
            },
          ],
        },
      })
    }
    let events
    try {
      const response = await mf.dispatchFetch(
        origin + '/api/parse',
        parseRequest(source, 'application/json', {
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        }),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toContain('application/x-ndjson')
      expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform')
      events = ndjson(response)
      const first = await events.next()
      expect(first.value).toMatchObject({
        type: 'preview',
        data: { images: [{ watermarkFree: false }] },
      })
      // The upstream completion is still blocked: a buffered response would deadlock here.
      completion.resolve()
      const rest = []
      for await (const event of events) rest.push(event)
      expect(rest.at(-1)).toMatchObject({
        type: 'result',
        data: {
          images: [{ url: 'https://p.douyinpic.com/final.jpg', watermarkFree: true }],
          parseStatus: 'complete',
        },
      })
      expect(rest.filter((event) => event.type === 'result')).toHaveLength(1)
      expect(rest.some((event) => event.type === 'error')).toBe(false)
    } finally {
      completion.resolve()
      await events?.return()
    }
  }, 15000)

  test('an upstream parser failure after NDJSON opens is an error event, never a result', async () => {
    upstream = () => new Response('PRIVATE_UPSTREAM_FAILURE', { status: 503 })
    const response = await mf.dispatchFetch(
      origin + '/api/parse',
      parseRequest(source, 'application/json', {
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson')
    const events = []
    for await (const event of ndjson(response)) events.push(event)
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'VIDEO_RESOURCE_NOT_FOUND',
          message: expect.any(String),
        },
      },
    ])
    expect(JSON.stringify(events)).not.toContain('PRIVATE_UPSTREAM_FAILURE')
    expect(requests.length).toBeGreaterThan(0)
  }, 15000)

  test('206 downloads preserve binary bytes, range and honest framing without decompression', async () => {
    const bytes = new Uint8Array([0, 128, 255, 1])
    upstream = () =>
      new Response(bytes, {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(bytes.byteLength),
          'Content-Range': 'bytes 2-5/10',
          'Accept-Ranges': 'bytes',
          'Content-Encoding': 'identity',
        },
      })
    const response = await mf.dispatchFetch(
      origin + '/api/download?url=' + encodeURIComponent(media) + '&filename=test.mp4',
      {
        headers: { Range: 'bytes=2-5' },
      },
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Disposition')).toContain('attachment')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range')
    const received = new Uint8Array(await response.arrayBuffer())
    expect(received).toEqual(bytes)
    // workerd removes a caller-supplied Content-Length for an arbitrary guarded
    // ReadableStream and uses chunked framing. Both representations must be honest.
    const length = response.headers.get('Content-Length')
    if (length === null) expect(response.headers.get('Transfer-Encoding')).toBe('chunked')
    else expect(Number(length)).toBe(received.byteLength)
    const [, start, end] = response.headers.get('Content-Range').match(/^bytes (\d+)-(\d+)\/10$/)
    expect(Number(end) - Number(start) + 1).toBe(received.byteLength)
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.range).toBe('bytes=2-5')
    expect(requests[0].headers['accept-encoding']).toBe('identity')
  })

  test('416 keeps the unsatisfied range and never forwards an upstream error body as media', async () => {
    upstream = () =>
      new Response('PRIVATE_RANGE_ERROR', {
        status: 416,
        headers: {
          'Content-Type': 'text/html',
          'Content-Length': '19',
          'Content-Range': 'bytes */10',
          'Accept-Ranges': 'bytes',
        },
      })
    const response = await mf.dispatchFetch(
      origin + '/api/download?url=' + encodeURIComponent(media),
      {
        headers: { Range: 'bytes=99-' },
      },
    )
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */10')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Disposition')).toBeNull()
    expect(response.headers.get('Content-Type')).toBeNull()
    expect(await response.text()).toBe('')
    expect(Number(response.headers.get('Content-Length'))).toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.range).toBe('bytes=99-')
    expect(requests[0].headers['accept-encoding']).toBe('identity')
  })

  test.each([200, 206])(
    'compressed HTTP %s media is rejected before misleading byte headers escape',
    async (status) => {
      const compressed = gzipSync(new Uint8Array([0, 128, 255, 1]))
      upstream = () =>
        new Response(compressed, {
          status,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Encoding': 'gzip',
            'Content-Length': String(compressed.byteLength),
            ...(status === 206 ? { 'Content-Range': 'bytes 0-23/24' } : {}),
          },
        })
      const response = await mf.dispatchFetch(
        origin + '/api/download?url=' + encodeURIComponent(media),
      )
      expect(response.status).toBe(502)
      expect(response.headers.get('Content-Type')).toContain('application/json')
      expect(response.headers.get('Content-Disposition')).toBeNull()
      expect(response.headers.get('Content-Range')).toBeNull()
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'DOWNLOAD_FAILED' },
      })
      expect(requests[0].headers['accept-encoding']).toBe('identity')
    },
  )

  test('a media response is streamed before the upstream closes', async () => {
    const completion = deferred()
    const bytes = new Uint8Array([0, 128, 255, 1])
    upstream = () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(bytes)
            await completion.promise
            controller.enqueue(bytes)
            controller.close()
          },
        }),
        { headers: { 'Content-Type': 'video/mp4' } },
      )
    let reader
    try {
      const response = await mf.dispatchFetch(
        origin + '/api/download?url=' + encodeURIComponent(media),
      )
      expect(response.status).toBe(200)
      reader = response.body.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(first.value).toEqual(bytes)
      completion.resolve()
      const rest = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        rest.push(...value)
      }
      expect(rest).toEqual([...bytes])
    } finally {
      completion.resolve()
      await reader?.cancel().catch(() => {})
    }
  }, 15000)
})
