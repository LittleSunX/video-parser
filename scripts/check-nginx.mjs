import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  fixtureBytes,
  fixtureId,
  fixtureMedia,
  fixtureSource,
  startFixture,
} from '../tests/fixtures/nginx-upstream.mjs'

export function prerequisites() {
  if (process.platform !== 'linux') {
    throw new Error(
      'Prerequisite: Linux with nginx and openssl is required; use Linux CI or WSL (no checks were skipped).',
    )
  }
  for (const [name, fallback, args] of [
    ['NGINX_BIN', 'nginx', ['-v']],
    ['OPENSSL_BIN', 'openssl', ['version']],
  ]) {
    const result = spawnSync(process.env[name] || fallback, args, {
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`Prerequisite: ${name} must point to a working ${fallback} executable`)
    }
  }
}

// Only deployment coordinates change. Security, routing, buffering and timeout
// directives stay byte-for-byte from the real template (including regressions).
export function renderTemplate(template, { directory, httpPort, httpsPort, nodePort }) {
  return template
    .replaceAll('listen 80 ', `listen 127.0.0.1:${httpPort} `)
    .replaceAll('listen [::]:80 ', `listen [::1]:${httpPort} `)
    .replaceAll('listen 443 ', `listen 127.0.0.1:${httpsPort} `)
    .replaceAll('listen [::]:443 ', `listen [::1]:${httpsPort} `)
    .replaceAll('http://127.0.0.1:8787', `http://127.0.0.1:${nodePort}`)
    .replaceAll('/etc/letsencrypt/live/example.com/fullchain.pem', `"${directory}/cert.pem"`)
    .replaceAll('/etc/letsencrypt/live/example.com/privkey.pem', `"${directory}/key.pem"`)
    .replaceAll('/opt/video-parser/current/frontend', `"${directory}/frontend"`)
    .replaceAll('/var/log/nginx/video-parser.access.log', `"${directory}/access.log"`)
    .replaceAll('/dev/null', `"${directory}/error.log"`)
    .replaceAll('https://example.com$request_uri', `https://fixture.test:${httpsPort}$request_uri`)
    .replaceAll('example.com', 'fixture.test')
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pass = (name) => console.log(`PASS ${name}`)
const queryMarker = 'fixture_QUERY_private_726'
const signatureMarker = 'fixture_SIGNATURE_private_726'
const errorToken = '11111111-2222-4333-8444-555555555555'
const secretQuery = new URLSearchParams({
  fixture: queryMarker,
  signature: signatureMarker,
  errorToken,
}).toString()
const downloadPath = (media = fixtureMedia) =>
  '/api/download?' +
  new URLSearchParams({
    url: media + '?signature=' + signatureMarker,
    errorToken,
    fixture: queryMarker,
    filename: 'fixture.mp4',
  })

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, `${binary} failed: ${result.error?.message ?? result.stderr}`)
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function stopChild(child) {
  if (!child?.pid) return
  const signal = (name) => {
    try {
      process.kill(-child.pid, name)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  signal('SIGTERM')
  for (let i = 0; i < 100 && groupExists(child.pid); i++) await delay(20)
  if (groupExists(child.pid)) signal('SIGKILL')
  for (let i = 0; i < 100 && groupExists(child.pid); i++) await delay(20)
  assert.equal(groupExists(child.pid), false, `Process group ${child.pid} survived cleanup`)
}

export async function checkNginx() {
  prerequisites()
  for (const file of [
    'server/dist/index.mjs',
    'server/dist/version.json',
    'frontend/dist/index.html',
    'frontend/dist/version.json',
  ]) {
    await access(join(root, file)).catch(() => {
      throw new Error(`Prerequisite: npm run build must produce ${file}`)
    })
  }
  const directory = await mkdtemp(join(tmpdir(), 'video-parser-nginx-fixture-'))
  const children = [],
    reservations = [],
    clients = new Set()
  let fixture, interrupted, ca, failure
  let reported = false
  const ports = []
  const checkInterrupted = () => {
    if (interrupted) throw interrupted
  }
  const interrupt = (signal) => {
    interrupted ??= new Error(`Interrupted: ${signal}`)
    for (const client of clients) client.destroy(interrupted)
  }
  const onTerm = () => interrupt('SIGTERM')
  const onInt = () => interrupt('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  const deadline = setTimeout(() => interrupt('75s integration deadline'), 75_000)
  const resources = () => ({
    directory,
    ports,
    pids: children.map((child) => child.pid).filter(Boolean),
  })
  const launch = (binary, args, env = process.env) => {
    checkInterrupted()
    const child = spawn(binary, args, {
      env,
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.output = ''
    child.stdout.on('data', (chunk) => {
      child.output += chunk
    })
    child.stderr.on('data', (chunk) => {
      child.output += chunk
    })
    child.on('error', (error) => {
      interrupted ??= error
    })
    children.push(child)
    return child
  }
  const reserve = async () => {
    const server = net.createServer()
    reservations.push(server)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    assert.ok(port > 1024)
    ports.push(port)
    return { port, release: () => new Promise((resolve) => server.close(resolve)) }
  }
  const waitFor = async (predicate, label, timeout = 5000) => {
    const end = Date.now() + timeout
    do {
      checkInterrupted()
      if (await predicate()) return
      await delay(20)
    } while (Date.now() < end)
    throw new Error(`Timed out: ${label}`)
  }
  const open = (origin, path, options = {}) =>
    new Promise((resolve, reject) => {
      checkInterrupted()
      const url = new URL(path, origin)
      const secure = url.protocol === 'https:'
      const client = (secure ? https : http).request(url, {
        agent: false,
        method: options.method ?? 'GET',
        ...(secure ? { ca, servername: 'fixture.test' } : {}),
        headers: { Host: 'fixture.test', ...options.headers },
      })
      clients.add(client)
      const timeout = setTimeout(
        () => client.destroy(new Error(`HTTP deadline: ${url.pathname}`)),
        6000,
      )
      client.once('close', () => {
        clearTimeout(timeout)
        clients.delete(client)
      })
      client.on('error', reject)
      client.once('response', (response) => {
        response.on('error', () => {})
        resolve(response)
      })
      if (options.chunks) for (const chunk of options.chunks) client.write(chunk)
      client.end(options.body)
    })
  const request = async (origin, path, options) => {
    const response = await open(origin, path, options)
    const chunks = []
    for await (const chunk of response) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    return {
      status: response.statusCode,
      headers: response.headers,
      body,
      text: body.toString(),
      json: () => JSON.parse(body),
    }
  }
  try {
    // Quote-safe sandbox paths; reject configuration metacharacters, never interpolate them.
    assert.ok(!/["\\$\r\n;]/.test(directory), 'TMPDIR contains nginx configuration metacharacters')
    const nginx = process.env.NGINX_BIN || 'nginx'
    const openssl = process.env.OPENSSL_BIN || 'openssl'
    const version = JSON.parse(await readFile(join(root, 'server/dist/version.json'), 'utf8'))
    const staticVersion = await readFile(join(root, 'frontend/dist/version.json'))
    const index = await readFile(join(root, 'frontend/dist/index.html'))
    await cp(join(root, 'frontend/dist'), join(directory, 'frontend'), { recursive: true })
    for (const name of ['client', 'proxy', 'fastcgi', 'uwsgi', 'scgi'])
      await mkdir(join(directory, name))
    run(openssl, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=fixture.test',
      '-addext',
      'subjectAltName=DNS:fixture.test',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ])
    ca = await readFile(join(directory, 'cert.pem'))
    fixture = await startFixture()
    ports.push(Number(new URL(fixture.origin).port))
    const node = await reserve(),
      plain = await reserve(),
      tls = await reserve()
    const origin = `https://127.0.0.1:${tls.port}`
    const direct = `http://127.0.0.1:${node.port}`
    const template = await readFile(join(root, 'deploy/nginx.conf'), 'utf8')
    const rendered = renderTemplate(template, {
      directory,
      nodePort: node.port,
      httpPort: plain.port,
      httpsPort: tls.port,
    })
    await writeFile(join(directory, 'site.conf'), rendered)
    // Only the http{} wrapper is test infrastructure. All application policy is
    // included from the deployment template, with its original timeouts unchanged.
    await writeFile(
      join(directory, 'nginx.conf'),
      `daemon off;
worker_processes 1;
pid "${directory}/nginx.pid";
error_log "${directory}/error.log" crit;
events { worker_connections 128; }
http {
  client_body_temp_path "${directory}/client";
  proxy_temp_path "${directory}/proxy";
  fastcgi_temp_path "${directory}/fastcgi";
  uwsgi_temp_path "${directory}/uwsgi";
  scgi_temp_path "${directory}/scgi";
  include "${directory}/site.conf";
}
`,
    )
    const nginxArgs = [
      '-p',
      directory + '/',
      '-c',
      join(directory, 'nginx.conf'),
      '-e',
      join(directory, 'error.log'),
    ]
    run(nginx, [...nginxArgs, '-t'])
    pass('nginx -t')
    await node.release()
    const app = launch(
      process.execPath,
      [
        '--import',
        join(root, 'tests/fixtures/nginx-preload.mjs'),
        join(root, 'server/dist/index.mjs'),
      ],
      {
        ...process.env,
        NODE_OPTIONS: '',
        HOST: '127.0.0.1',
        PORT: String(node.port),
        TRUST_PROXY: 'loopback',
        MAX_CONCURRENT_PARSES: '8',
        MAX_CONCURRENT_DOWNLOADS: '4',
        MAX_DOWNLOADS_PER_IP: '1',
        // Shorten only the Node shutdown grace period; no production request timeout changes.
        SHUTDOWN_TIMEOUT_MS: '500',
        NGINX_FIXTURE_ORIGIN: fixture.origin,
        NGINX_FIXTURE_BLOCKED_LOG: join(directory, 'blocked.log'),
      },
    )
    await waitFor(() => {
      assert.equal(app.exitCode, null, `Node exited during startup: ${app.output}`)
      return app.output.includes('server_listening')
    }, 'production Node bundle listening')
    await plain.release()
    await tls.release()
    const proxy = launch(nginx, nginxArgs)
    console.log(JSON.stringify({ resources: resources() }))
    reported = true
    await waitFor(async () => {
      assert.equal(proxy.exitCode, null, `nginx exited: ${proxy.output}`)
      try {
        return (await request(origin, '/api/health')).status === 200
      } catch {
        return false
      }
    }, 'nginx HTTPS listener')

    const diagnostics = (response) => {
      assert.equal(response.headers['access-control-allow-origin'], '*')
      assert.equal(response.headers['x-worker-version'], version.id)
      assert.equal(response.headers['x-api-version'], version.id)
      assert.equal(response.headers['x-api-runtime'], 'node')
      assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/i)
      for (const header of ['X-Request-ID', 'X-API-Version', 'X-API-Runtime'])
        assert.ok(response.headers['access-control-expose-headers'].includes(header))
    }
    const health = await request(origin, '/api/health?' + secretQuery, {
      headers: { Origin: 'https://fixture-client.test' },
    })
    assert.equal(health.status, 200)
    diagnostics(health)
    assert.deepEqual(health.json(), {
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
    const preflight = await request(origin, '/api/parse', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://fixture-client.test',
        'Access-Control-Request-Headers': 'Content-Type, Range',
      },
    })
    assert.equal(preflight.status, 204)
    diagnostics(preflight)
    assert.match(preflight.headers['access-control-allow-methods'], /POST/)
    assert.match(preflight.headers['access-control-allow-headers'], /Range/)
    pass('HTTPS health/version/CORS')

    const redirect = await request(
      `http://127.0.0.1:${plain.port}`,
      '/fixture-route?' + secretQuery,
    )
    assert.equal(redirect.status, 308)
    assert.equal(
      redirect.headers.location,
      `https://fixture.test:${tls.port}/fixture-route?${secretQuery}`,
    )
    for (const [path, expected] of [
      ['/version.json', staticVersion],
      ['/index.html', index],
      ['/fixture-spa-route', index],
    ]) {
      const response = await request(origin, path)
      assert.equal(response.status, 200)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.deepEqual(response.body, expected)
    }
    for (const path of ['/assets/fixture-does-not-exist.js', '/api', '/api/fixture-missing']) {
      const response = await request(origin, path)
      assert.equal(response.status, 404, path)
      assert.notDeepEqual(response.body, index)
      if (path.endsWith('fixture-missing')) assert.equal(response.json().success, false)
    }
    pass('static and API routing')

    const spoofed = {
      'X-Real-IP': 'fixture-invalid-address',
      'X-Forwarded-For': '203.0.113.77',
      Forwarded: 'for=203.0.113.88',
      'CF-Connecting-IP': '203.0.113.99',
    }
    const denied = await request(direct, '/api/health', { headers: spoofed })
    assert.equal(denied.status, 400)
    assert.equal(denied.json().error.code, 'INVALID_CLIENT_ADDRESS')
    const normalized = await request(origin, '/api/health', { headers: spoofed })
    assert.equal(normalized.status, 200)
    diagnostics(normalized)
    pass('X-Real-IP spoof resistance')

    const parseHeaders = { 'Content-Type': 'application/json' }
    const base = JSON.stringify({ url: fixtureSource, padding: '' })
    const body = JSON.stringify({
      url: fixtureSource,
      padding: 'x'.repeat(32 * 1024 - Buffer.byteLength(base)),
    })
    assert.equal(Buffer.byteLength(body), 32 * 1024)
    const accepted = await request(origin, '/api/parse', {
      method: 'POST',
      headers: { ...parseHeaders, 'Content-Length': Buffer.byteLength(body) },
      body,
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json().data.videoId, fixtureId)
    const before = fixture.hits.length
    for (const chunked of [false, true]) {
      const bytes = Buffer.from(body + ' ')
      const rejected = await request(origin, '/api/parse', {
        method: 'POST',
        headers: { ...parseHeaders, ...(!chunked ? { 'Content-Length': bytes.length } : {}) },
        ...(chunked
          ? { chunks: [bytes.subarray(0, 16000), bytes.subarray(16000)] }
          : { body: bytes }),
      })
      assert.equal(rejected.status, 413)
      diagnostics(rejected)
      assert.equal(rejected.json().error.code, 'INPUT_TOO_LARGE')
    }
    // Unknown API route distinguishes proxy acceptance from the application's 32KiB cap.
    const atProxyLimit = await request(origin, '/api/fixture-body-limit', {
      method: 'POST',
      headers: { 'Content-Length': 64 * 1024 },
      body: Buffer.alloc(64 * 1024, 120),
    })
    assert.equal(atProxyLimit.status, 404)
    diagnostics(atProxyLimit)
    const proxyRejected = await request(origin, '/api/parse', {
      method: 'POST',
      headers: { ...parseHeaders, 'Content-Length': 64 * 1024 + 1 },
      body: Buffer.alloc(64 * 1024 + 1, 120),
    })
    assert.equal(proxyRejected.status, 413)
    assert.equal(proxyRejected.headers['x-api-runtime'], undefined)
    assert.match(proxyRejected.headers['content-type'], /text\/html/)
    assert.equal(fixture.hits.length, before)
    pass('32KiB application / 64KiB proxy limits')

    fixture.state.preview = true
    const stream = await open(origin, '/api/parse', {
      method: 'POST',
      headers: { ...parseHeaders, Accept: 'application/x-ndjson' },
      body: JSON.stringify({ url: fixtureSource }),
    })
    assert.equal(stream.statusCode, 200)
    assert.match(stream.headers['content-type'], /application\/x-ndjson/)
    assert.equal(stream.headers['cache-control'], 'no-store, no-transform')
    let pending = '',
      first = false
    const events = []
    for await (const chunk of stream) {
      pending += chunk.toString()
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        const event = JSON.parse(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        events.push(event)
        if (!first) {
          first = true
          assert.equal(event.type, 'preview')
          assert.equal(event.data.images[0].watermarkFree, false)
          await waitFor(() => fixture.state.pending > 0, 'gated parser upstream')
          assert.equal(fixture.state.released, false)
          assert.equal(fixture.state.completed, 0)
          fixture.releasePreview()
        }
      }
    }
    assert.equal(pending, '')
    assert.equal(events.filter((event) => event.type === 'result').length, 1)
    assert.equal(events.at(-1).type, 'result')
    assert.equal(events.at(-1).data.images[0].watermarkFree, true)
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    )
    assert.ok(fixture.state.completed > 0)
    pass('incremental NDJSON preview')

    for (const range of ['bytes=2-5', 'bytes=99-']) {
      const response = await request(origin, downloadPath(), { headers: { Range: range } })
      diagnostics(response)
      assert.equal(response.headers['accept-ranges'], 'bytes')
      assert.ok(response.headers['access-control-expose-headers'].includes('Content-Range'))
      if (range === 'bytes=2-5') {
        assert.equal(response.status, 206)
        assert.equal(response.headers['content-range'], `bytes 2-5/${fixtureBytes.length}`)
        assert.equal(response.headers['content-length'], '4')
        assert.deepEqual(response.body, fixtureBytes.subarray(2, 6))
      } else {
        assert.equal(response.status, 416)
        assert.equal(response.headers['content-range'], `bytes */${fixtureBytes.length}`)
        assert.equal(response.headers['content-disposition'], undefined)
        assert.equal(response.body.length, 0)
      }
      assert.equal(fixture.hits.at(-1).headers.range, range)
      assert.match(fixture.hits.at(-1).headers['accept-encoding'], /^identity(?:,\s*identity)*$/)
    }
    pass('Range 206/416 bytes')

    const held = await open(origin, downloadPath('https://v.douyinvod.com/fixture-hold.mp4'), {
      headers: { 'X-Real-IP': '203.0.113.11' },
    })
    assert.equal(held.statusCode, 200)
    const iterator = held[Symbol.asyncIterator]()
    assert.deepEqual((await iterator.next()).value, fixtureBytes)
    const hanging = fixture.state.hanging.at(-1)
    assert.equal(hanging.response.writableEnded, false)
    assert.equal(hanging.closed, false)
    const busy = await request(origin, '/api/download?url=' + encodeURIComponent(fixtureMedia), {
      headers: { 'X-Real-IP': '203.0.113.12' },
    })
    assert.equal(busy.status, 503)
    assert.equal(busy.json().error.code, 'SERVER_BUSY')
    held.destroy()
    await waitFor(() => hanging.closed, 'client abort reaches native-fetch upstream socket', 2500)
    assert.equal(hanging.socket.destroyed, true)
    assert.equal(hanging.response.writableEnded, false)
    const resumed = await request(origin, downloadPath())
    assert.equal(resumed.status, 200)
    assert.deepEqual(resumed.body, fixtureBytes)
    pass('disconnect cancels upstream')

    const bad = await request(origin, '/api/download?' + secretQuery)
    assert.equal(bad.status, 400)
    assert.ok(bad.text.includes(errorToken))
    const invalidHost = await request(origin, '/api/health?' + secretQuery, {
      headers: { Host: 'fixture bad host' },
    })
    assert.equal(invalidHost.status, 400)
    const upstreamError = await request(
      origin,
      downloadPath('https://v.douyinvod.com/fixture-failure.mp4'),
    )
    assert.equal(upstreamError.status, 502)
    assert.ok(upstreamError.text.includes(errorToken))
    await stopChild(app)
    const gateway = await request(origin, '/api/health?' + secretQuery)
    assert.equal(gateway.status, 502)
    assert.equal(gateway.headers['x-api-runtime'], undefined)
    await stopChild(proxy) // Flush logs before inspecting them; nginx workers must exit too.
    const accessLog = await readFile(join(directory, 'access.log'), 'utf8')
    const errorLog = await readFile(join(directory, 'error.log'), 'utf8')
    for (const log of [accessLog, errorLog, ...children.map((child) => child.output)]) {
      for (const secret of [
        queryMarker,
        signatureMarker,
        errorToken,
        'errorToken=',
        'signature=',
        'url=',
      ])
        assert.equal(log.includes(secret), false, `Log leaked ${secret}`)
    }
    const records = accessLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const [uri, status] of [
      ['/api/health', 200],
      ['/api/health', 400],
      ['/api/health', 502],
      ['/api/download', 400],
      ['/api/download', 502],
    ]) {
      assert.ok(
        records.some((record) => record.uri === uri && record.status === status),
        `Missing access log ${uri} ${status}`,
      )
    }
    assert.ok(records.some((record) => record.request_id === health.headers['x-request-id']))
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), [
        'bytes',
        'duration',
        'method',
        'request_id',
        'status',
        'time',
        'uri',
      ])
      assert.equal(record.uri.includes('?'), false)
    }
    assert.equal(
      await readFile(join(directory, 'blocked.log'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      }),
      '',
    )
    pass('safe logs: normal/400/502')
  } catch (error) {
    failure = error
  } finally {
    clearTimeout(deadline)
    const failures = []
    for (const client of clients) client.destroy()
    for (const child of [...children].reverse())
      await stopChild(child).catch((error) => failures.push(error))
    if (fixture) await fixture.close().catch((error) => failures.push(error))
    for (const server of reservations)
      if (server.listening) await new Promise((resolve) => server.close(resolve))
    if (!reported) console.log(JSON.stringify({ resources: resources() }))
    await rm(directory, { recursive: true, force: true }).catch((error) => failures.push(error))
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
    if (failures.length)
      failure = new AggregateError([...(failure ? [failure] : []), ...failures], 'Cleanup failed')
    else pass('cleanup')
  }
  if (failure) throw failure
  checkInterrupted()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkNginx()
  } catch (error) {
    console.error(error.stack ?? error.message)
    process.exitCode = 1
  }
}
