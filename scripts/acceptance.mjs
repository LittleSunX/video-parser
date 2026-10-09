import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { URL, URLSearchParams } from 'node:url'
import {
  cli,
  endpoint,
  isCommit,
  isMain,
  isUuid,
  options,
  readJson,
  report,
  timeoutValue,
  withSignal,
} from './release-utils.mjs'

const labels = { video: '普通视频', image: '普通图文', 'live-photo': '实况图文' }
const metadataExpectations = {
  hasAuthor: 'author',
  hasCover: 'cover',
  hasMusic: 'musicUrl',
  hasMusicTitle: 'musicTitle',
}
const metadataLabels = {
  hasAuthor: '作者',
  hasCover: '封面',
  hasMusic: '音乐地址',
  hasMusicTitle: '音乐标题',
}

function mediaAddress(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === '443')
    )
  } catch {
    return false
  }
}

function sourceAddress(value, videoId) {
  if (!mediaAddress(value)) return false
  const url = new URL(value)
  if (
    !['douyin.com', 'iesdouyin.com'].some(
      (host) => url.hostname === host || url.hostname.endsWith('.' + host),
    )
  )
    return false
  if (!videoId) return true
  const id =
    /\/(?:share\/)?(?:video|note|slides|aweme\/detail)\/(\d+)/.exec(url.pathname)?.[1] ??
    url.searchParams.get('modal_id') ??
    url.searchParams.get('aweme_id') ??
    url.searchParams.get('video_id')
  return id === videoId
}

export function validateSamples(manifest) {
  const samples = manifest?.samples
  if (!Array.isArray(samples) || samples.length < 3 || samples.length > 6)
    throw new Error('验收清单需包含 3 至 6 个真实样本')
  for (const sample of samples) {
    if (!Object.hasOwn(labels, sample?.kind ?? ''))
      throw new Error('样本类别必须是 video、image 或 live-photo')
    if (typeof sample.input !== 'string' || !sample.input.trim() || sample.input.length > 8192)
      throw new Error('请为每个样本填写真实分享链接或文案，长度不超过 8192 字符')
    const inputUrl = sample.input
      .match(/https?:\/\/[^\s<>"']+/i)?.[0]
      .replace(/[，。；！？、）】》」』),.;!?]+$/g, '')
    if (!sourceAddress(inputUrl)) throw new Error('样本分享地址必须属于抖音 HTTPS 域名且不含凭据')
    const expected = sample.expected
    if (
      ![expected?.images, expected?.livePhotos].every(
        (count) => Number.isInteger(count) && count >= 0 && count <= 200,
      )
    )
      throw new Error('每个样本需填写预期图片和动态视频数量')
    if (
      expected.livePhotos > expected.images ||
      (sample.kind === 'video' && (expected.images !== 0 || expected.livePhotos !== 0)) ||
      (sample.kind === 'image' && (expected.images < 1 || expected.livePhotos !== 0)) ||
      (sample.kind === 'live-photo' && (expected.images < 1 || expected.livePhotos < 1))
    )
      throw new Error('样本类别与预期资源数量不一致')
    if (
      expected.videoId !== undefined &&
      (typeof expected.videoId !== 'string' || !/^[0-9]{5,32}$/.test(expected.videoId))
    )
      throw new Error('预期作品 ID 格式无效')
    for (const field of Object.keys(metadataExpectations)) {
      if (expected[field] !== undefined && typeof expected[field] !== 'boolean')
        throw new Error('元信息存在性预期必须是布尔值')
    }
    if (
      expected.minWatermarkFreeImages !== undefined &&
      (!Number.isInteger(expected.minWatermarkFreeImages) ||
        expected.minWatermarkFreeImages < 0 ||
        expected.minWatermarkFreeImages > expected.images)
    )
      throw new Error('无水印图片数量下限必须在预期图片数量范围内')
  }
  if (!Object.keys(labels).every((kind) => samples.some((sample) => sample.kind === kind)))
    throw new Error('验收需覆盖普通视频、普通图文和实况图文三类')
  return samples
}

function metadata(response) {
  const id = response.headers.get('X-Request-ID')
  return {
    requestId: isUuid(id) ? id : null,
    workerVersion: response.headers.get('X-Worker-Version'),
  }
}

function assertVersion(response, version) {
  if (version && metadata(response).workerVersion !== version)
    throw new Error('请求返回的 Worker 版本发生变化或缺失，请重新核对上线版本')
}

export function inspectParsed(sample, data) {
  const images = Array.isArray(data?.images) ? data.images : []
  const imageCount = images.filter((image) => image?.url).length
  const liveCount = images.filter((image) => image?.livePhotoUrl).length
  const watermarkFreeImages = images.filter(
    (image) => image?.url && image.watermarkFree === true,
  ).length
  const presentMetadata = Object.fromEntries(
    Object.entries(metadataExpectations).map(([flag, field]) => [
      flag,
      typeof data?.[field] === 'string' && !!data[field].trim(),
    ]),
  )
  const failures = []
  if (typeof data?.title !== 'string' || !data.title.trim()) failures.push('解析标题缺失')
  if (data?.platform !== 'douyin') failures.push('解析平台不符合预期')
  if (typeof data?.videoId !== 'string' || !/^[0-9]{5,32}$/.test(data.videoId))
    failures.push('解析作品 ID 格式无效')
  if (!sourceAddress(data?.sourceUrl, data?.videoId))
    failures.push('解析来源地址无效或作品 ID 不一致')
  if (sample.expected.videoId && data?.videoId !== sample.expected.videoId)
    failures.push('解析作品 ID 不符合预期')
  if (imageCount !== sample.expected.images || liveCount !== sample.expected.livePhotos)
    failures.push('图片或动态视频数量不符合预期')
  if (sample.kind === 'video') {
    if (data?.mediaType !== 'video' || !mediaAddress(data.videoUrl))
      failures.push('未获取有效普通视频资源')
  } else if (data?.mediaType !== 'image' || data.imagesComplete !== true) {
    failures.push('图文资源完整性未确认')
  }
  if (
    images.some(
      (image) =>
        !mediaAddress(image?.url) || (image?.livePhotoUrl && !mediaAddress(image.livePhotoUrl)),
    )
  )
    failures.push('图文资源地址无效')
  if (presentMetadata.hasCover && !mediaAddress(data.cover)) failures.push('封面地址无效')
  if (presentMetadata.hasMusic && !mediaAddress(data.musicUrl)) failures.push('音乐地址无效')
  for (const flag of Object.keys(metadataExpectations)) {
    if (sample.expected[flag] !== undefined && sample.expected[flag] !== presentMetadata[flag])
      failures.push('解析元信息不符合预期：' + metadataLabels[flag])
  }
  if (watermarkFreeImages < (sample.expected.minWatermarkFreeImages ?? 0))
    failures.push('无水印图片数量低于预期下限')
  return {
    images: imageCount,
    livePhotos: liveCount,
    watermarkFreeImages,
    ...presentMetadata,
    imagesComplete: data?.imagesComplete === true,
    parseStatus: ['complete', 'unverified'].includes(data?.parseStatus) ? data.parseStatus : null,
    parseReason: ['complete', 'exhausted', 'timeout'].includes(data?.parseReason)
      ? data.parseReason
      : null,
    failures,
  }
}

export async function probeMedia(
  { worker, mediaUrl, kind, version, timeout = 45000, signal: parentSignal },
  fetchFn = globalThis.fetch,
) {
  const started = Date.now()
  if (!mediaAddress(mediaUrl)) throw new Error('媒体地址无效')
  const signal = globalThis.AbortSignal.any([
    globalThis.AbortSignal.timeout(timeout),
    ...(parentSignal ? [parentSignal] : []),
  ])
  const url = new URL(endpoint(worker, 'api/download'))
  url.searchParams.set('url', mediaUrl)
  url.searchParams.set('filename', kind === 'image' ? 'acceptance.jpg' : 'acceptance.mp4')
  const limit = 1024
  let response
  try {
    response = await fetchFn(url.href, {
      headers: { Range: 'bytes=0-' + (limit - 1) },
      signal,
      redirect: 'error',
    })
  } catch {
    throw new Error('媒体前缀请求失败或超时')
  }
  let reader
  try {
    if (![200, 206].includes(response.status))
      throw Object.assign(new Error('下载接口返回 HTTP ' + response.status), {
        status: response.status,
      })
    assertVersion(response, version)
    if (!(response.headers.get('Content-Type') ?? '').toLowerCase().startsWith(kind + '/'))
      throw new Error('下载接口未返回预期媒体类型')
    if (!/^attachment(?:;|$)/i.test(response.headers.get('Content-Disposition') ?? ''))
      throw new Error('下载接口缺少附件响应头')
    let expectedBytes
    if (response.status === 206) {
      const match = /^bytes 0-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '')
      if (
        !match ||
        Number(match[1]) >= limit ||
        (match[2] !== '*' &&
          (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= Number(match[1])))
      )
        throw new Error('下载接口的 Range 响应无效')
      expectedBytes = Number(match[1]) + 1
    }
    if (!response.body) throw new Error('媒体响应为空')
    reader = response.body.getReader()
    let bytes = 0
    let receivedBytes = 0
    const target = expectedBytes ?? limit
    while (bytes < target) {
      const chunk = await withSignal(reader.read(), signal)
      if (chunk.done) break
      receivedBytes += chunk.value.byteLength
      if (expectedBytes && receivedBytes > expectedBytes)
        throw new Error('媒体 Range 前缀超过声明长度')
      bytes += Math.min(chunk.value.byteLength, target - bytes)
    }
    if (!bytes || (expectedBytes && bytes !== expectedBytes))
      throw new Error('媒体响应为空或前缀被截断')
    return {
      kind: kind === 'image' ? '图片' : '视频',
      status: response.status,
      prefixBytes: bytes,
      receivedBytes,
      rangeSupported: response.status === 206,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    if (error instanceof Error && /^(请求返回|下载接口|媒体)/.test(error.message)) throw error
    throw new Error('媒体前缀读取失败或超时', { cause: error })
  } finally {
    // 200 表示上游可能忽略 Range；读到前缀即停止，禁止 arrayBuffer/blob 完整下载。
    if (reader) void reader.cancel().catch(() => {})
    else void response.body?.cancel().catch(() => {})
  }
}

export async function runAcceptance(
  { worker, manifest, timeout = 45000, deadline = 120000, dryRun = false, parseOnly = false },
  fetchFn = globalThis.fetch,
) {
  const samples = validateSamples(manifest)
  const parseUrl = endpoint(worker, 'api/parse')
  const planned = samples.map((sample, index) => ({
    sample: index + 1,
    kind: labels[sample.kind],
    expected: {
      images: sample.expected.images,
      livePhotos: sample.expected.livePhotos,
      ...(sample.expected.videoId ? { videoId: sample.expected.videoId } : {}),
      ...Object.fromEntries(
        [...Object.keys(metadataExpectations), 'minWatermarkFreeImages']
          .filter((field) => sample.expected[field] !== undefined)
          .map((field) => [field, sample.expected[field]]),
      ),
    },
  }))
  if (dryRun) return { mode: '仅预览样本，未联网', samples: planned }
  const batchSignal = globalThis.AbortSignal.timeout(deadline)
  const healthSignal = globalThis.AbortSignal.any([
    batchSignal,
    globalThis.AbortSignal.timeout(timeout),
  ])
  let health
  try {
    const response = await fetchFn(endpoint(worker, 'api/health'), {
      signal: healthSignal,
      redirect: 'error',
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error()
    }
    health = await readJson(response, { signal: healthSignal, maxBytes: 16 * 1024 })
    if (
      health?.success !== true ||
      health.data?.service !== 'video-parser-api' ||
      health.data.status !== 'ok' ||
      !isUuid(health.data.version)
    )
      throw new Error()
  } catch {
    throw new Error('Worker 健康检查失败，未执行样本验收')
  }
  const version = health.data.version
  const results = []
  let limited = false
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    if (limited || batchSignal.aborted) {
      results.push({
        ...planned[index],
        passed: false,
        failures: [limited ? '因限流停止后续样本' : '因整体期限停止后续样本'],
      })
      continue
    }
    const started = Date.now()
    const result = { ...planned[index], passed: false, downloads: [] }
    try {
      const signal = globalThis.AbortSignal.any([
        batchSignal,
        globalThis.AbortSignal.timeout(timeout),
      ])
      let response = await fetchFn(parseUrl, {
        method: 'POST',
        body: new URLSearchParams({ url: sample.input }),
        signal,
        redirect: 'error',
      })
      if (response.status === 415) {
        void response.body?.cancel().catch(() => {})
        response = await fetchFn(parseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: sample.input }),
          signal,
          redirect: 'error',
        })
      }
      const requestMetadata = metadata(response)
      result.requestId = requestMetadata.requestId
      result.status = response.status
      limited = response.status === 429
      const body = await readJson(response, { signal })
      result.parseDurationMs = Date.now() - started
      assertVersion(response, version)
      if (!response.ok || body?.success !== true) {
        const code = /^[A-Z_]{1,64}$/.test(body?.error?.code ?? '') ? body.error.code : 'UNKNOWN'
        throw new Error('解析失败：HTTP ' + response.status + '，错误码 ' + code)
      }
      const inspected = inspectParsed(sample, body.data)
      Object.assign(result, inspected)
      if (!inspected.failures.length && !parseOnly) {
        const media =
          sample.kind === 'video'
            ? [{ mediaUrl: body.data.videoUrl, kind: 'video' }]
            : [
                { mediaUrl: body.data.images.find((image) => image.url).url, kind: 'image' },
                ...(sample.kind === 'live-photo'
                  ? [
                      {
                        mediaUrl: body.data.images.find((image) => image.livePhotoUrl).livePhotoUrl,
                        kind: 'video',
                      },
                    ]
                  : []),
              ]
        for (const item of media)
          result.downloads.push(
            await probeMedia({ worker, ...item, version, timeout, signal: batchSignal }, fetchFn),
          )
      }
      result.passed = !inspected.failures.length
    } catch (error) {
      if (error?.status === 429) limited = true
      // 不输出上游消息、分享文案或带签名的媒体 URL。
      result.failures = [
        ...(result.failures ?? []),
        error instanceof Error && error.message.match(/^(请求返回|下载接口|媒体|解析失败)/)
          ? error.message
          : '解析请求失败、超时或响应无效',
      ]
    }
    result.durationMs = Date.now() - started
    results.push(result)
  }
  return {
    scope: parseOnly ? '接口解析验收' : '接口解析与媒体前缀验收',
    deadlineMs: deadline,
    passed: results.every((result) => result.passed),
    workerVersion: version,
    workerCommit: isCommit(health.data.versionTag) ? health.data.versionTag : null,
    deviceVerification: '未执行真实手机浏览器与系统保存验收',
    samples: results,
  }
}

export async function main(args = process.argv.slice(2)) {
  const flags = options(args, {
    help: 'boolean',
    worker: 'string',
    samples: 'string',
    timeout: 'string',
    deadline: 'string',
    'dry-run': 'boolean',
    'parse-only': 'boolean',
  })
  if (flags.help) {
    process.stdout.write(
      '用法：npm run release:acceptance -- --worker <Worker地址> --samples <本地清单.json> [--dry-run] [--parse-only] [--timeout <毫秒>] [--deadline <整体毫秒>]\n复制 scripts/acceptance-samples.example.json 到已忽略的 docs 或本地目录，填写真实样本。\n样本顺序执行，单次请求默认 45 秒，整体默认 120 秒；遇到限流或整体期限停止后续样本。\n媒体读取至 1 KiB 前缀后立即取消流；实际接收可能包含网络预读的数据块，报告 receivedBytes。\n此脚本不代表手机浏览器或系统保存验收。\n',
    )
    return
  }
  if (!flags.worker || !flags.samples) throw new Error('请显式指定 Worker 地址和本地真实样本清单')
  let manifest
  try {
    manifest = JSON.parse(await readFile(flags.samples, 'utf8'))
  } catch {
    throw new Error('无法读取样本清单，请检查路径和 JSON 格式')
  }
  const result = await runAcceptance({
    worker: flags.worker,
    manifest,
    timeout: timeoutValue(flags.timeout),
    deadline: timeoutValue(flags.deadline, 120000),
    dryRun: flags['dry-run'],
    parseOnly: flags['parse-only'],
  })
  report(result)
  if (result.passed === false) process.exitCode = 1
}

if (isMain(import.meta.url)) await cli(() => main())
