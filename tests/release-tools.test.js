import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { releasePlan } from '../scripts/release-worker.mjs'
import { checkRelease, compareVersions } from '../scripts/check-release.mjs'
import {
  inspectParsed,
  probeMedia,
  runAcceptance,
  validateSamples,
} from '../scripts/acceptance.mjs'
import {
  endpoint,
  isTimestamp,
  options,
  readJson,
  requireCommit,
} from '../scripts/release-utils.mjs'

const commit = 'a'.repeat(40)
const timestamp = '2026-10-09T01:00:00.000Z'
const parsedIdentity = {
  videoId: '1234567890123456789',
  sourceUrl: 'https://www.douyin.com/video/1234567890123456789',
  title: '本地测试作品',
}
const health = {
  success: true,
  data: {
    service: 'video-parser-api',
    status: 'ok',
    version: '01234567-89ab-cdef-0123-456789abcdef',
    versionTag: commit,
    versionCreatedAt: timestamp,
  },
}
const manifest = {
  samples: [
    {
      kind: 'video',
      input: '分享文案 https://v.douyin.com/secret-video/',
      expected: { images: 0, livePhotos: 0 },
    },
    {
      kind: 'image',
      input: 'https://v.douyin.com/secret-image/',
      expected: { images: 1, livePhotos: 0 },
    },
    {
      kind: 'live-photo',
      input: 'https://v.douyin.com/secret-live/',
      expected: { images: 3, livePhotos: 3 },
    },
  ],
}
const mediaHeaders = {
  'Content-Type': 'video/mp4',
  'Content-Disposition': 'attachment; filename=video.mp4',
  'X-Worker-Version': '01234567-89ab-cdef-0123-456789abcdef',
}

test('版本核对要求两个服务都匹配完整提交，空 tag 不算成功', () => {
  const frontend = { commit, builtAt: timestamp }
  assert.equal(compareVersions(frontend, health, commit).passed, true)
  assert.equal(
    compareVersions({ ...frontend, commit: 'b'.repeat(40) }, health, commit).passed,
    false,
  )
  const missingTag = compareVersions(
    frontend,
    { ...health, data: { ...health.data, versionTag: null } },
    commit,
  )
  assert.deepEqual(missingTag.failures, ['Worker 未标记完整提交版本'])
  assert.equal(
    compareVersions(frontend, { ...health, data: { ...health.data, version: 'unknown' } }, commit)
      .passed,
    false,
  )
})

test('Cloudflare microsecond timestamps pass while invalid calendar dates are rejected', () => {
  const createdAt = '2026-10-08T08:30:11.736031Z'
  assert.equal(isTimestamp(createdAt), true)
  assert.equal(isTimestamp('2026-02-30T08:30:11.736031Z'), false)
  assert.equal(
    compareVersions(
      { commit, builtAt: timestamp },
      { ...health, data: { ...health.data, versionCreatedAt: createdAt } },
      commit,
    ).passed,
    true,
  )
})

test('正式发布阻止脏工作区，dry-run 保留提交 tag 并且只本地打包', () => {
  assert.throws(() => releasePlan({ commit, dirty: true }, { deploy: true }), /提交工作区/)
  assert.throws(
    () => releasePlan({ commit, dirty: false }, { deploy: true, dryRun: true }),
    /同时指定/,
  )
  assert.throws(() => releasePlan({ commit: 'unknown', dirty: false }), /40 位/)
  assert.throws(() => releasePlan({ commit }, { deploy: true }), /无法确认/)
  assert.deepEqual(releasePlan({ commit, dirty: true }, { dryRun: true }).args, [
    'deploy',
    '--tag',
    commit,
    '--dry-run',
    '--outdir',
    'dist',
  ])
  assert.equal(releasePlan({ commit, dirty: false }).mode, '仅预览命令')
})

test('参数和服务地址校验拒绝未知开关、重复参数和 URL 凭据', () => {
  assert.throws(() => options(['--temporary'], { deploy: 'boolean' }), /未知/)
  assert.throws(
    () => options(['--worker', 'https://a', '--worker', 'https://b'], { worker: 'string' }),
    /重复/,
  )
  assert.throws(() => endpoint('https://user:secret@host/', 'api/health'), /凭据/)
  assert.equal(endpoint('https://host/prefix', 'api/health'), 'https://host/prefix/api/health')
})

test('所有只读 dry-run 均不发起网络请求且不泄露分享文案', async () => {
  const fetchFn = vi.fn(() => {
    throw new Error('不应联网')
  })
  const versions = await checkRelease(
    { frontend: 'https://frontend', worker: 'https://worker', commit, dryRun: true },
    fetchFn,
  )
  assert.equal(versions.expectedCommit, commit)
  const samples = await runAcceptance({ worker: 'https://worker', manifest, dryRun: true }, fetchFn)
  assert.equal(samples.samples.length, 3)
  assert.equal(JSON.stringify(samples).includes('secret'), false)
  assert.equal(fetchFn.mock.calls.length, 0)
})

test('样本清单要求三类覆盖和已填写真实输入，资源计数要精确匹配', () => {
  assert.throws(
    () =>
      validateSamples({
        samples: manifest.samples.map((sample) => ({ ...sample, kind: 'video' })),
      }),
    /类别与预期|三类/,
  )
  assert.throws(
    () =>
      validateSamples({ samples: manifest.samples.map((sample) => ({ ...sample, input: '' })) }),
    /真实分享/,
  )
  assert.throws(
    () =>
      validateSamples({
        samples: manifest.samples.map((sample) => ({
          ...sample,
          expected: { images: 1, livePhotos: 2 },
        })),
      }),
    /类别与预期/,
  )
  const parsed = {
    platform: 'douyin',
    ...parsedIdentity,
    mediaType: 'image',
    imagesComplete: true,
    images: [{ url: 'image', livePhotoUrl: 'live' }],
  }
  assert.notEqual(inspectParsed(manifest.samples[2], parsed).failures.length, 0)
})

test('上游忽略 Range 返回 200 时只读前缀并取消，绝不消耗完整媒体流', async () => {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(1024))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  const fetchFn = vi.fn(async (_url, config) => {
    assert.equal(config.headers.Range, 'bytes=0-1023')
    return new Response(body, { headers: mediaHeaders })
  })
  const result = await probeMedia(
    {
      worker: 'https://worker',
      mediaUrl: 'https://cdn/signed?secret=token',
      kind: 'video',
      version: '01234567-89ab-cdef-0123-456789abcdef',
      timeout: 1000,
    },
    fetchFn,
  )
  assert.equal(result.prefixBytes, 1024)
  assert.equal(result.rangeSupported, false)
  assert.equal(pulls, 1)
  assert.equal(cancelled, true)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('媒体探测拒绝伪装成下载的 HTML、截断 Range 和版本切换', async () => {
  const config = {
    worker: 'https://worker',
    mediaUrl: 'https://cdn/video',
    kind: 'video',
    version: '01234567-89ab-cdef-0123-456789abcdef',
    timeout: 1000,
  }
  await assert.rejects(
    probeMedia(
      config,
      async () =>
        new Response('html', { headers: { ...mediaHeaders, 'Content-Type': 'text/html' } }),
    ),
    /预期媒体/,
  )
  await assert.rejects(
    probeMedia(
      config,
      async () =>
        new Response(new Uint8Array(2), {
          status: 206,
          headers: { ...mediaHeaders, 'Content-Range': 'bytes 0-1023/2000' },
        }),
    ),
    /截断/,
  )
  await assert.rejects(
    probeMedia(
      config,
      async () =>
        new Response('video', { headers: { ...mediaHeaders, 'X-Worker-Version': 'other' } }),
    ),
    /版本发生变化/,
  )
})

test('样本兼容旧 Worker 的 415，一次 JSON 回退，并报告成功资源', async () => {
  let parses = 0
  const fetchFn = vi.fn(async (url, config) => {
    if (url.endsWith('/api/health')) return Response.json(health)
    if (url.endsWith('/api/parse')) {
      parses++
      if (parses === 1) return new Response('', { status: 415 })
      if (parses === 2) assert.equal(config.headers['Content-Type'], 'application/json')
      const data =
        parses === 2
          ? {
              platform: 'douyin',
              ...parsedIdentity,
              mediaType: 'video',
              videoUrl: 'https://cdn/private-token',
            }
          : {
              platform: 'douyin',
              ...parsedIdentity,
              mediaType: 'image',
              imagesComplete: true,
              images: Array.from({ length: parses === 3 ? 1 : 3 }, () => ({
                url: 'https://cdn/private-image',
                ...(parses === 4 ? { livePhotoUrl: 'https://cdn/private-live' } : {}),
              })),
            }
      return Response.json(
        { success: true, data },
        { headers: { 'X-Worker-Version': '01234567-89ab-cdef-0123-456789abcdef' } },
      )
    }
    return new Response(new Uint8Array(1024), {
      status: 206,
      headers: {
        ...mediaHeaders,
        'Content-Type': url.includes('private-image') ? 'image/jpeg' : 'video/mp4',
        'Content-Range': 'bytes 0-1023/4096',
      },
    })
  })
  const result = await runAcceptance({ worker: 'https://worker', manifest, timeout: 1000 }, fetchFn)
  assert.equal(result.passed, true)
  assert.equal(result.samples[2].downloads.length, 2)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.match(result.deviceVerification, /未执行真实手机/)
})

test('限流后停止解析后续样本，不自动重试', async () => {
  const fetchFn = vi.fn(async (url) =>
    url.endsWith('/api/health')
      ? Response.json(health)
      : Response.json(
          { success: false, error: { code: 'RATE_LIMITED', message: '不应输出' } },
          { status: 429, headers: { 'X-Worker-Version': '01234567-89ab-cdef-0123-456789abcdef' } },
        ),
  )
  const result = await runAcceptance({ worker: 'https://worker', manifest, timeout: 1000 }, fetchFn)
  assert.equal(result.passed, false)
  assert.equal(fetchFn.mock.calls.length, 2)
  assert.match(result.samples[1].failures[0], /限流停止/)
  assert.equal(JSON.stringify(result).includes('不应输出'), false)
})

test('下载限流也会停止后续样本，并且取消错误响应流', async () => {
  let cancelled = false
  const fetchFn = vi.fn(async (url) => {
    if (url.endsWith('/api/health')) return Response.json(health)
    if (url.endsWith('/api/parse'))
      return Response.json(
        {
          success: true,
          data: {
            platform: 'douyin',
            ...parsedIdentity,
            mediaType: 'video',
            videoUrl: 'https://cdn/video',
          },
        },
        { headers: { 'X-Worker-Version': '01234567-89ab-cdef-0123-456789abcdef' } },
      )
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status: 429, headers: { 'X-Worker-Version': '01234567-89ab-cdef-0123-456789abcdef' } },
    )
  })
  const result = await runAcceptance({ worker: 'https://worker', manifest, timeout: 1000 }, fetchFn)
  assert.equal(result.passed, false)
  assert.equal(fetchFn.mock.calls.length, 3)
  assert.equal(cancelled, true)
  assert.match(result.samples[1].failures[0], /限流停止/)
})

test('提交和时间格式不能借助宽松字符串转换通过版本校验', () => {
  assert.throws(() => requireCommit([commit]), /完整/)
  assert.equal(isTimestamp('1'), false)
  assert.equal(isTimestamp('2026-02-31T01:00:00.000Z'), false)
  assert.equal(isTimestamp('2026-10-09T01:00:00Z'), true)
  assert.equal(compareVersions({ commit, builtAt: '1' }, health, commit).passed, false)
})

test('来源作品必须匹配，资源地址不能用非 HTTPS 地址凑计数', () => {
  const sample = {
    ...manifest.samples[0],
    expected: { images: 0, livePhotos: 0, videoId: parsedIdentity.videoId },
  }
  const data = {
    ...parsedIdentity,
    platform: 'douyin',
    mediaType: 'video',
    videoUrl: 'https://cdn/video.mp4',
  }
  assert.equal(inspectParsed(sample, data).failures.length, 0)
  assert.notEqual(
    inspectParsed(sample, {
      ...data,
      sourceUrl: 'https://www.douyin.com/video/9999999999999999999',
    }).failures.length,
    0,
  )
  assert.notEqual(
    inspectParsed(sample, { ...data, videoUrl: 'javascript:secret' }).failures.length,
    0,
  )
  assert.throws(
    () =>
      validateSamples({
        samples: manifest.samples.map((value) => ({
          ...value,
          input: 'https://douyin.com.evil/secret/',
        })),
      }),
    /分享地址/,
  )
})

test('JSON 字节上限与期限覆盖响应正文，cancel 停滞不能拖延失败返回', async () => {
  let cancelled = false
  await assert.rejects(
    readJson(
      new Response(new Uint8Array(17), { headers: { 'Content-Type': 'application/json' } }),
      { maxBytes: 16 },
    ),
    /字节上限/,
  )
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true
        return new Promise(() => {})
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
  const started = Date.now()
  await assert.rejects(readJson(response, { signal: AbortSignal.timeout(25) }), /超时/)
  assert.equal(cancelled, true)
  assert.ok(Date.now() - started < 500)
})

test('版本接口一侧失败后立即取消另一侧在途请求', async () => {
  let peerSignal
  await assert.rejects(
    checkRelease(
      { frontend: 'https://frontend', worker: 'https://worker', commit, timeout: 1000 },
      (url, config) => {
        if (url.endsWith('version.json'))
          return Promise.resolve(new Response('html', { headers: { 'Content-Type': 'text/html' } }))
        peerSignal = config.signal
        return new Promise((resolve, reject) =>
          config.signal.addEventListener('abort', () => reject(config.signal.reason), {
            once: true,
          }),
        )
      },
    ),
    /版本接口请求失败/,
  )
  assert.equal(peerSignal.aborted, true)
})

test('200 的额外数据块如实计入 receivedBytes，206 的声明外字节会失败', async () => {
  const config = {
    worker: 'https://worker',
    mediaUrl: 'https://cdn/video',
    kind: 'video',
    version: health.data.version,
    timeout: 1000,
  }
  const result = await probeMedia(
    config,
    async () => new Response(new Uint8Array(65536), { headers: mediaHeaders }),
  )
  assert.equal(result.prefixBytes, 1024)
  assert.equal(result.receivedBytes, 65536)
  await assert.rejects(
    probeMedia(
      config,
      async () =>
        new Response(new Uint8Array(3), {
          status: 206,
          headers: { ...mediaHeaders, 'Content-Range': 'bytes 0-1/4096' },
        }),
    ),
    /超过声明/,
  )
  let pulls = 0
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(2))
      },
    },
    { highWaterMark: 0 },
  )
  const tiny = await probeMedia(
    config,
    async () =>
      new Response(body, {
        status: 206,
        headers: { ...mediaHeaders, 'Content-Range': 'bytes 0-1/4096' },
      }),
  )
  assert.equal(tiny.prefixBytes, 2)
  assert.equal(pulls, 1)
})

test('样本整体期限停止后续请求，未知 Worker 版本不能通过验收', async () => {
  const fetchFn = vi.fn(async (url) =>
    url.endsWith('/api/health')
      ? Response.json(health)
      : new Response(new ReadableStream(), {
          headers: { 'Content-Type': 'application/json', 'X-Worker-Version': health.data.version },
        }),
  )
  const result = await runAcceptance(
    { worker: 'https://worker', manifest, timeout: 1000, deadline: 25 },
    fetchFn,
  )
  assert.equal(result.passed, false)
  assert.equal(fetchFn.mock.calls.length, 2)
  assert.match(result.samples[1].failures[0], /整体期限/)
  const unknown = vi.fn(async () =>
    Response.json({ ...health, data: { ...health.data, version: 'unknown' } }),
  )
  await assert.rejects(
    runAcceptance({ worker: 'https://worker', manifest, timeout: 1000 }, unknown),
    /健康检查失败/,
  )
  assert.equal(unknown.mock.calls.length, 1)
})

test('标题必需，作者、封面、音乐和无水印质量下限可作为验收断言', () => {
  const sample = {
    ...manifest.samples[1],
    expected: {
      images: 1,
      livePhotos: 0,
      hasAuthor: true,
      hasCover: true,
      hasMusic: true,
      hasMusicTitle: true,
      minWatermarkFreeImages: 1,
    },
  }
  const data = {
    ...parsedIdentity,
    platform: 'douyin',
    mediaType: 'image',
    imagesComplete: true,
    images: [{ url: 'https://p.douyinpic.com/fixture.jpg', watermarkFree: true }],
    author: '测试作者',
    cover: 'https://p.douyinpic.com/cover.jpg',
    musicUrl: 'https://p.douyinpic.com/music.mp3',
    musicTitle: '测试音乐',
  }
  assert.equal(inspectParsed(sample, data).failures.length, 0)
  for (const field of ['author', 'cover', 'musicUrl', 'musicTitle'])
    assert.match(
      inspectParsed(sample, { ...data, [field]: undefined }).failures.join(' '),
      /元信息/,
    )
  assert.match(inspectParsed(sample, { ...data, title: '' }).failures.join(' '), /标题缺失/)
  assert.match(
    inspectParsed(sample, {
      ...data,
      images: [{ url: data.images[0].url, watermarkFree: false }],
    }).failures.join(' '),
    /无水印/,
  )
  assert.throws(
    () =>
      validateSamples({
        samples: manifest.samples.map((entry) => ({
          ...entry,
          expected: { ...entry.expected, hasAuthor: 'true' },
        })),
      }),
    /布尔值/,
  )
})
