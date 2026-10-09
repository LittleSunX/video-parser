import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'vitest'
import { repositoryRoot } from '../scripts/release-utils.mjs'

const commit = 'a'.repeat(40)
const version = '01234567-89ab-cdef-0123-456789abcdef'
const timestamp = '2026-10-09T01:00:00.000Z'
const health = {
  success: true,
  data: {
    service: 'video-parser-api',
    status: 'ok',
    version,
    versionTag: commit,
    versionCreatedAt: timestamp,
  },
}
const manifest = {
  samples: [
    {
      kind: 'video',
      input: 'https://v.douyin.com/fixture-video/',
      expected: { videoId: '1234567890123456781', images: 0, livePhotos: 0 },
    },
    {
      kind: 'image',
      input: 'https://v.douyin.com/fixture-image/',
      expected: { videoId: '1234567890123456782', images: 1, livePhotos: 0 },
    },
    {
      kind: 'live-photo',
      input: 'https://v.douyin.com/fixture-live/',
      expected: { videoId: '1234567890123456783', images: 3, livePhotos: 3 },
    },
  ],
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'X-Worker-Version': version })
  response.end(JSON.stringify(body))
}

async function parseBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString()).get('url')
}

async function parseResult(request, response) {
  const input = await parseBody(request)
  const sample = manifest.samples.find((entry) => entry.input === input)
  const data = {
    platform: 'douyin',
    title: '本地 fixture 测试作品',
    videoId: sample.expected.videoId,
    sourceUrl: 'https://www.douyin.com/video/' + sample.expected.videoId,
    mediaType: sample.kind === 'video' ? 'video' : 'image',
    imagesComplete: true,
    parseStatus: 'complete',
    parseReason: 'complete',
  }
  if (sample.kind === 'video') data.videoUrl = 'https://v.douyinvod.com/fixture.mp4'
  else
    data.images = Array.from({ length: sample.expected.images }, () => ({
      url: 'https://p.douyinpic.com/fixture.jpg',
      watermarkFree: true,
      ...(sample.kind === 'live-photo'
        ? { livePhotoUrl: 'https://v.douyinvod.com/fixture-live.mp4' }
        : {}),
    }))
  json(response, { success: true, data })
}

function runCli(script, args) {
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      [join(repositoryRoot, 'scripts', script), ...args],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    ),
  )
}

async function fixture(handler, action) {
  const directory = await mkdtemp(join(tmpdir(), 'video-parser-release-cli-'))
  const samples = join(directory, 'samples.json')
  await writeFile(samples, JSON.stringify(manifest))
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    await action(base, samples)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await unlink(samples)
    await rmdir(directory)
  }
}

test('本地 CLI 端到端核对版本，错配通过非零退出码阻止验收', async () => {
  let frontendCommit = commit
  await fixture(
    (request, response) =>
      json(
        response,
        request.url === '/version.json' ? { commit: frontendCommit, builtAt: timestamp } : health,
      ),
    async (base) => {
      const args = ['--frontend', base, '--worker', base, '--commit', commit]
      const matching = await runCli('check-release.mjs', args)
      assert.equal(matching.code, 0, matching.stderr)
      assert.equal(JSON.parse(matching.stdout).passed, true)
      frontendCommit = 'b'.repeat(40)
      const mismatch = await runCli('check-release.mjs', args)
      assert.equal(mismatch.code, 1)
      assert.match(JSON.parse(mismatch.stdout).failures[0], /前端提交/)
    },
  )
})

test('本地 CLI 端到端覆盖普通视频、图文、实况和媒体前缀', async () => {
  let parses = 0
  let downloads = 0
  await fixture(
    async (request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname
      if (path === '/api/health') return json(response, health)
      if (path === '/api/parse') {
        parses++
        return parseResult(request, response)
      }
      downloads++
      const image = request.url.includes('fixture.jpg')
      response.writeHead(206, {
        'Content-Type': image ? 'image/jpeg' : 'video/mp4',
        'Content-Range': 'bytes 0-1023/4096',
        'Content-Disposition': 'attachment; filename=fixture',
        'X-Worker-Version': version,
      })
      response.end(Buffer.alloc(1024))
    },
    async (base, samples) => {
      const result = await runCli('acceptance.mjs', ['--worker', base, '--samples', samples])
      assert.equal(result.code, 0, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.equal(report.passed, true)
      assert.equal(parses, 3)
      assert.equal(downloads, 4)
      assert.equal(report.samples[2].downloads.length, 2)
      assert.equal(result.stdout.includes('v.douyin.com'), false)
      assert.match(report.deviceVerification, /未执行真实手机/)
    },
  )
})

test('本地 CLI 对已收到响应头但正文停滞的版本接口仍按期限退出', async () => {
  let requests = 0
  await fixture(
    (request, response) => {
      requests++
      if (request.url === '/version.json') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.write('{"commit":')
      } else json(response, health)
    },
    async (base) => {
      const started = Date.now()
      const result = await runCli('check-release.mjs', [
        '--frontend',
        base,
        '--worker',
        base,
        '--commit',
        commit,
        '--timeout',
        '100',
      ])
      assert.equal(result.code, 1)
      assert.match(result.stderr, /版本接口请求失败/)
      assert.equal(requests, 2)
      assert.ok(Date.now() - started < 2000)
    },
  )
})

test('本地 CLI 收到非 JSON 下载 429 也停止后续样本', async () => {
  let parses = 0
  await fixture(
    async (request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname
      if (path === '/api/health') return json(response, health)
      if (path === '/api/parse') {
        parses++
        return parseResult(request, response)
      }
      response.writeHead(429, { 'Content-Type': 'text/html' })
      response.end('不应输出的上游消息')
    },
    async (base, samples) => {
      const result = await runCli('acceptance.mjs', ['--worker', base, '--samples', samples])
      assert.equal(result.code, 1)
      assert.equal(parses, 1, result.stderr)
      const report = JSON.parse(result.stdout)
      assert.match(report.samples[1].failures[0], /限流停止/)
      assert.equal(result.stdout.includes('上游消息'), false)
    },
  )
})
