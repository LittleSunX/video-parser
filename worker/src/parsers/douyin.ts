import { AppError } from '../errors/app-error'
import type { VideoInfo } from '../types/video'
import { extractDouyinVideoId, MOBILE_USER_AGENT } from '../utils/url'
import type { VideoParser } from './base'

interface DouyinItem {
  aweme_id?: string
  desc?: string
  duration?: number
  author?: {
    nickname?: string
  }
  video?: {
    duration?: number
    bit_rate?: unknown
    play_addr?: unknown
    play_addr_h264?: unknown
    download_addr?: unknown
    cover?: unknown
    origin_cover?: unknown
    dynamic_cover?: unknown
  }
  images?: unknown[]
  image_list?: unknown[]
  image_post_info?: {
    images?: unknown[]
    image_list?: unknown[]
  }
  music?: {
    title?: string
    play_url?: unknown
  }
}

const incompleteImageResults = new WeakSet<VideoInfo>()

export class DouyinParser implements VideoParser {
  supports(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      return (
        hostname === 'douyin.com' ||
        hostname.endsWith('.douyin.com') ||
        hostname === 'iesdouyin.com' ||
        hostname.endsWith('.iesdouyin.com')
      )
    } catch {
      return false
    }
  }

  async parse(url: string, signal?: AbortSignal): Promise<VideoInfo> {
    const sourceUrl = new URL(url)
    const videoId = extractDouyinVideoId(sourceUrl)

    if (!videoId) {
      throw new AppError('VIDEO_NOT_FOUND', '没有从链接中识别到抖音视频 ID')
    }

    const strategies = [
      {
        name: 'web-detail',
        run: () => this.parseFromWebDetail(videoId, sourceUrl, signal),
      },
      {
        name: 'mobile-feed',
        run: () => this.parseFromMobileFeed(videoId, sourceUrl, signal),
      },
      {
        name: 'mobile-ssr',
        run: () => this.parseFromMobileSsr(videoId, sourceUrl, signal),
      },
      {
        name: 'page-meta',
        run: () => this.parseFromCurrentPage(sourceUrl, videoId, signal),
      },
    ]

    const failures: string[] = []
    let bestImageResult: VideoInfo | undefined
    let bestImageScore = -1

    for (const strategy of strategies) {
      try {
        signal?.throwIfAborted()
        const result = await strategy.run()

        if (result.videoUrl) {
          return result
        }

        if ((result.images?.length ?? 0) > 0) {
          const score = scoreImageResult(result)

          if (score > bestImageScore) {
            bestImageResult = result
            bestImageScore = score
          }

          // 普通图文拿到完整原图即可返回；已发现实况字段但缺少动态轨时继续兜底。
          if (isHighConfidenceImageResult(result)) {
            return result
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          if (bestImageResult && signal.reason?.name === 'TimeoutError') return bestImageResult
          signal.throwIfAborted()
        }
        const message = error instanceof Error ? error.message : String(error)
        failures.push(strategy.name + ': ' + message)
        console.warn('[DouyinParser] strategy failed:', strategy.name, message)
      }
    }

    if (bestImageResult) {
      return bestImageResult
    }

    throw new AppError(
      'VIDEO_RESOURCE_NOT_FOUND',
      '视频资源解析失败：' + failures.join(' | '),
      422,
    )
  }

  private async parseFromWebDetail(
    videoId: string,
    sourceUrl: URL,
    signal?: AbortSignal,
  ): Promise<VideoInfo> {
    const endpoint =
      'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' +
      encodeURIComponent(videoId) +
      '&aid=6383'

    let lastError = 'Web Detail 未返回有效作品数据'

    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted()
      try {
        const response = await fetch(endpoint, {
          headers: buildWebDetailHeaders(),
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        })

        if (!response.ok) {
          lastError = 'HTTP ' + response.status
          continue
        }

        const text = await response.text()
        if (!text.trim()) {
          lastError = '接口返回空响应'
          continue
        }

        const data = JSON.parse(text) as unknown
        const item = findMediaItem(data, videoId)

        if (item) {
          return mapItemToVideoInfo(item, sourceUrl, videoId)
        }

        lastError = '响应中没有目标作品数据'
      } catch (error) {
        signal?.throwIfAborted()
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    throw new AppError('PARSE_FAILED', 'Web Detail 解析失败：' + lastError, 422)
  }
  private async parseFromMobileSsr(
    videoId: string,
    sourceUrl: URL,
    signal?: AbortSignal,
  ): Promise<VideoInfo> {
    const candidates = [
      sourceUrl.toString(),
      'https://www.iesdouyin.com/share/video/' + videoId + '/',
      'https://www.iesdouyin.com/share/video/' + videoId + '/?app=aweme',
      'https://www.iesdouyin.com/share/video/' + videoId + '/?from_ssr=1',
      'https://www.iesdouyin.com/share/note/' + videoId + '/',
      'https://www.iesdouyin.com/share/slides/' + videoId + '/',
      'https://m.douyin.com/share/note/' + videoId,
    ]

    let lastError: string | undefined

    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const response = await fetch(candidate, {
          method: 'GET',
          headers: buildPageHeaders(),
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        })

        if (!response.ok) {
          lastError = 'HTTP ' + response.status
          continue
        }

        const html = await response.text()

        if (!html || html.length < 1000) {
          lastError = '页面内容过少（' + html.length + ' 字节）'
          continue
        }

        const routerData = extractRouterData(html)

        if (!routerData) {
          lastError = '页面中未找到 _ROUTER_DATA'
          continue
        }

        const item = findMediaItem(routerData, videoId)

        if (!item) {
          const reason = findFilterReason(routerData)
          lastError = reason || '_ROUTER_DATA 中未找到目标作品 item'
          continue
        }

        return mapItemToVideoInfo(item, sourceUrl, videoId)
      } catch (error) {
        signal?.throwIfAborted()
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    throw new AppError(
      'PARSE_FAILED',
      '移动端 SSR 解析失败：' + (lastError || '未知原因'),
      422,
    )
  }

  private async parseFromMobileFeed(videoId: string, sourceUrl: URL, signal?: AbortSignal): Promise<VideoInfo> {
    const endpoints = [
      'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=6383',
      'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=1128',
      'https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=6383',
      'https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=1128',
    ]

    for (const endpoint of endpoints) {
      signal?.throwIfAborted()
      try {
        const response = await fetch(endpoint, {
          headers: {
            'User-Agent': MOBILE_USER_AGENT,
            Accept: 'application/json, text/plain, */*',
          },
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        })

        if (!response.ok) continue

        const data = (await response.json()) as unknown
        const item = findMediaItem(data, videoId)

        if (item) {
          return mapItemToVideoInfo(item, sourceUrl, videoId)
        }
      } catch {
        signal?.throwIfAborted()
        // 尝试备用移动端节点。
      }
    }

    throw new AppError('PARSE_FAILED', '移动端视频详情接口未返回有效数据', 422)
  }

  private async parseFromCurrentPage(
    sourceUrl: URL,
    videoId: string,
    signal?: AbortSignal,
  ): Promise<VideoInfo> {
    const response = await fetch(sourceUrl.toString(), {
      headers: buildPageHeaders(),
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    })

    if (!response.ok) {
      throw new AppError(
        'REQUEST_FAILED',
        '抖音视频页面请求失败（HTTP ' + response.status + '）',
        502,
      )
    }

    const html = await response.text()

    if (!pageMatchesExpectedVideo(response.url, html, videoId)) {
      throw new AppError(
        'VIDEO_NOT_FOUND',
        '当前页面返回的视频 ID 与目标视频不一致',
        422,
      )
    }

    const title = extractMeta(html, 'og:title') ?? '抖音视频'
    const author = extractMeta(html, 'author') ?? undefined
    const cover = extractMeta(html, 'og:image') ?? undefined
    const videoUrl =
      extractMeta(html, 'og:video:secure_url') ??
      extractMeta(html, 'og:video') ??
      extractMeta(html, 'twitter:player:stream')

    if (!videoUrl) {
      throw new AppError(
        'VIDEO_RESOURCE_NOT_FOUND',
        '视频页面存在，但页面中没有可用的视频媒体地址',
        422,
      )
    }

    return {
      platform: 'douyin',
      mediaType: 'video',
      videoId,
      sourceUrl: sourceUrl.toString(),
      title: normalizeText(title),
      author: author ? normalizeText(author) : undefined,
      cover: cover ? normalizeUrl(cover) : undefined,
      videoUrl: normalizeUrl(videoUrl),
    }
  }
}

interface VideoStreamCandidate {
  url: string
  width: number
  height: number
  pixels: number
  bitRate: number
  fileSize: number
}

function mapItemToVideoInfo(item: DouyinItem, sourceUrl: URL, fallbackVideoId: string): VideoInfo {
  const itemId = normalizeAwemeId(item.aweme_id)

  if (itemId && itemId !== fallbackVideoId) {
    throw new AppError(
      'VIDEO_ID_MISMATCH',
      '解析结果作品 ID 与目标作品不一致',
      422,
    )
  }

  const rawImages = [
    ...(item.image_post_info?.images ?? []),
    ...(item.image_post_info?.image_list ?? []),
    ...(item.images ?? []),
    ...(item.image_list ?? []),
  ]
  const imageAssets = extractImageAssets(rawImages)
  const video = item.video ?? {}
  const musicUrl = extractFirstUrl(item.music?.play_url)
  const cover =
    imageAssets[0]?.url ??
    extractFirstUrl(video.origin_cover) ??
    extractFirstUrl(video.cover) ??
    extractFirstUrl(video.dynamic_cover)

  if (imageAssets.length > 0) {
    const result: VideoInfo = {
      platform: 'douyin',
      mediaType: 'image',
      videoId: itemId ?? fallbackVideoId,
      sourceUrl: sourceUrl.toString(),
      title: normalizeText(item.desc || '抖音图文'),
      author: item.author?.nickname ? normalizeText(item.author.nickname) : undefined,
      cover: cover ? normalizeUrl(cover) : undefined,
      images: imageAssets,
      musicUrl: musicUrl ? normalizeUrl(musicUrl) : undefined,
      musicTitle: item.music?.title ? normalizeText(item.music.title) : undefined,
    }
    const incompleteImages = rawImages.some((image) => {
      if (!image || typeof image !== 'object' || Array.isArray(image)) return true
      const value = image as Record<string, unknown>
      const liveUrl = extractLivePhotoUrl(value)
      if (!selectBestImageUrl(value)?.url && !liveUrl) return true
      return !!(value.video || value.video_play_addr || value.video_download_addr) && !liveUrl
    })
    if (incompleteImages) incompleteImageResults.add(result)
    return result
  }

  const bestBitRateStream = selectBestBitRateStream(video.bit_rate)

  // 视频作品优先选择 bit_rate 中的最高画质流；没有候选时再回退到默认 play_addr。
  const videoUrl =
    bestBitRateStream?.url ??
    extractFirstUrl(video.play_addr) ??
    extractFirstUrl(video.play_addr_h264) ??
    extractFirstUrl(video.download_addr)

  if (!videoUrl) {
    throw new AppError(
      'VIDEO_RESOURCE_NOT_FOUND',
      '已获取作品信息，但没有找到视频播放地址或图文资源',
      422,
    )
  }

  if (bestBitRateStream) {
    console.info(
      '[DouyinParser] selected highest quality stream:',
      bestBitRateStream.width + 'x' + bestBitRateStream.height,
      'bitRate=' + bestBitRateStream.bitRate,
      'fileSize=' + bestBitRateStream.fileSize,
    )
  }

  return {
    platform: 'douyin',
    mediaType: 'video',
    videoId: itemId ?? fallbackVideoId,
    sourceUrl: sourceUrl.toString(),
    title: normalizeText(item.desc || '抖音视频'),
    author: item.author?.nickname ? normalizeText(item.author.nickname) : undefined,
    cover: cover ? normalizeUrl(cover) : undefined,
    duration: readNumber(item.duration) || readNumber(video.duration) || undefined,
    videoUrl: toPlayableUrl(normalizeUrl(videoUrl)),
    musicUrl: musicUrl ? normalizeUrl(musicUrl) : undefined,
    musicTitle: item.music?.title ? normalizeText(item.music.title) : undefined,
  }
}

function extractImageAssets(input: unknown): import('../types/video').ImageAsset[] {
  if (!Array.isArray(input)) {
    return []
  }

  const assets: import('../types/video').ImageAsset[] = []
  const seen = new Set<string>()

  for (const image of input) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) continue

    const object = image as Record<string, unknown>
    const selected = selectBestImageUrl(object)
    const livePhotoUrl = extractLivePhotoUrl(object)

    if (!selected?.url && !livePhotoUrl) continue

    const normalizedImage = selected?.url ? normalizeUrl(selected.url) : ''
    const normalizedLive = livePhotoUrl ? toPlayableUrl(normalizeUrl(livePhotoUrl)) : undefined
    const key = normalizedImage + '|' + (normalizedLive ?? '')

    if (seen.has(key)) continue
    seen.add(key)

    if (selected) {
      console.info(
        '[DouyinParser] selected image source:',
        selected.source,
        'watermarkFree=' + selected.watermarkFree,
      )
    }

    assets.push({
      url: normalizedImage,
      livePhotoUrl: normalizedLive,
      watermarkFree: selected?.watermarkFree ?? false,
    })
  }

  return assets
}

interface ImageUrlCandidate {
  url: string
  source: string
  rank: number
  watermarkFree: boolean
}

function selectBestImageUrl(image: Record<string, unknown>): ImageUrlCandidate | undefined {
  const sources: Array<[string, unknown, number, boolean]> = [
    ['watermark_free_download_url_list', image.watermark_free_download_url_list, 0, true],
    ['watermarkFreeDownloadUrlList', image.watermarkFreeDownloadUrlList, 0, true],
    ['origin_image', image.origin_image, 1, true],
    ['originImage', image.originImage, 1, true],
    ['display_image', image.display_image, 2, true],
    ['displayImage', image.displayImage, 2, true],
    ['url_list', image.url_list, 3, false],
    ['urlList', image.urlList, 3, false],
    ['image_url', image.image_url, 4, false],
    ['image', image.image, 4, false],
    ['origin_url', image.origin_url, 4, false],
    ['download_url', image.download_url, 10, false],
    ['download_addr', image.download_addr, 11, false],
    ['download_url_list', image.download_url_list, 12, false],
  ]

  const candidates: ImageUrlCandidate[] = []

  for (const [source, value, rank, watermarkFree] of sources) {
    for (const url of extractAllUrls(value)) {
      candidates.push({
        url,
        source,
        rank,
        watermarkFree: watermarkFree && !isWatermarkedMediaUrl(url),
      })
    }
  }

  candidates.sort((left, right) => {
    if (left.watermarkFree !== right.watermarkFree) return left.watermarkFree ? -1 : 1
    if (left.rank !== right.rank) return left.rank - right.rank
    return imageFormatRank(left.url) - imageFormatRank(right.url)
  })

  return candidates[0]
}

function extractAllUrls(input: unknown): string[] {
  if (typeof input === 'string') {
    const value = normalizeUrl(input)
    return /^https?:\/\//i.test(value) ? [value] : []
  }

  if (Array.isArray(input)) {
    return input.flatMap(extractAllUrls)
  }

  if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>
    for (const key of ['url_list', 'urlList']) {
      if (key in object) {
        const urls = extractAllUrls(object[key])
        if (urls.length > 0) return urls
      }
    }

    for (const key of ['url', 'src']) {
      if (key in object) {
        const urls = extractAllUrls(object[key])
        if (urls.length > 0) return urls
      }
    }
  }

  return []
}

function isWatermarkedMediaUrl(url: string): boolean {
  const normalized = url.toLowerCase()
  return [
    'tplv-dy-water',
    'dy-water',
    'owner_watermark',
    'watermark_image',
    'watermark=1',
    'playwm',
  ].some((hint) => normalized.includes(hint))
}

function imageFormatRank(url: string): number {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return url.toLowerCase()
    }
  })()

  return path.includes('.webp') ? 1 : 0
}

function scoreImageResult(result: VideoInfo): number {
  const images = result.images ?? []
  const liveCount = images.filter((image) => !!image.livePhotoUrl).length
  const cleanCount = images.filter((image) => image.watermarkFree).length
  return liveCount * 10000 + cleanCount * 100 + images.length
}

function isHighConfidenceImageResult(result: VideoInfo): boolean {
  const images = result.images ?? []
  if (images.length === 0) return false
  const allClean = images.every((image) => image.watermarkFree || !image.url)
  return allClean && !incompleteImageResults.has(result)
}

function extractLivePhotoUrl(image: Record<string, unknown>): string | undefined {
  let video: Record<string, unknown> | undefined

  if (image.video && typeof image.video === 'object' && !Array.isArray(image.video)) {
    video = image.video as Record<string, unknown>
  } else if (image.video_play_addr && typeof image.video_play_addr === 'object') {
    video = { play_addr: image.video_play_addr }
  } else if (image.video_download_addr && typeof image.video_download_addr === 'object') {
    video = { download_addr: image.video_download_addr }
  }

  if (!video) return undefined

  for (const key of ['play_addr', 'play_addr_h264', 'play_addr_lowbr', 'download_addr']) {
    const address = video[key]
    const uri = extractUri(address)

    if (uri) {
      if (/^https?:\/\//i.test(uri)) return uri
      if (!/mp3/i.test(uri)) return buildLivePhotoPlayUrl(uri)
    }

    const directUrl = extractFirstUrl(address)
    if (directUrl && !/\.mp3(?:$|\?)/i.test(directUrl)) return directUrl
  }

  const vid = typeof video.vid === 'string' ? video.vid.trim() : ''
  if (vid && !/mp3/i.test(vid)) {
    return /^https?:\/\//i.test(vid) ? vid : buildLivePhotoPlayUrl(vid)
  }

  return undefined
}

function extractUri(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const uri = (input as Record<string, unknown>).uri
  return typeof uri === 'string' && uri.trim() ? uri.trim() : undefined
}

function buildLivePhotoPlayUrl(videoId: string): string {
  return (
    'https://www.iesdouyin.com/aweme/v1/play/?video_id=' +
    encodeURIComponent(videoId) +
    '&ratio=1080p&line=0&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH'
  )
}

function selectBestBitRateStream(input: unknown): VideoStreamCandidate | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined
  }

  const candidates = input
    .map(toVideoStreamCandidate)
    .filter((candidate): candidate is VideoStreamCandidate => candidate !== undefined)

  if (candidates.length === 0) {
    return undefined
  }

  candidates.sort(compareVideoStreamCandidates)

  return candidates[0]
}

function toVideoStreamCandidate(input: unknown): VideoStreamCandidate | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }

  const entry = input as Record<string, unknown>
  const playAddr =
    entry.play_addr && typeof entry.play_addr === 'object' && !Array.isArray(entry.play_addr)
      ? (entry.play_addr as Record<string, unknown>)
      : undefined

  const url = extractFirstUrl(entry.play_addr)
  if (!url) {
    return undefined
  }

  const width = readNumber(playAddr?.width) || readNumber(entry.width)
  const height = readNumber(playAddr?.height) || readNumber(entry.height)
  const bitRate =
    readNumber(entry.bit_rate) ||
    readNumber(entry.bitRate) ||
    readNumber(playAddr?.bit_rate) ||
    readNumber(playAddr?.bitRate)

  const fileSize =
    readNumber(playAddr?.data_size) ||
    readNumber(playAddr?.file_size) ||
    readNumber(playAddr?.size) ||
    readNumber(entry.data_size) ||
    readNumber(entry.file_size) ||
    readNumber(entry.size)

  return {
    url,
    width,
    height,
    pixels: width > 0 && height > 0 ? width * height : 0,
    bitRate,
    fileSize,
  }
}

function compareVideoStreamCandidates(
  left: VideoStreamCandidate,
  right: VideoStreamCandidate,
): number {
  // 画质优先级：
  // 1. 分辨率（总像素）
  // 2. 码率
  // 3. 文件大小
  // 三项都降序，确保同分辨率下优先选择码率和数据量更高的流。
  if (right.pixels !== left.pixels) {
    return right.pixels - left.pixels
  }

  if (right.bitRate !== left.bitRate) {
    return right.bitRate - left.bitRate
  }

  return right.fileSize - left.fileSize
}

function readNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  return 0
}

function extractRouterData(html: string): unknown | undefined {
  const marker = /window\._ROUTER_DATA\s*=\s*/
  const match = marker.exec(html)

  if (!match || match.index === undefined) {
    return undefined
  }

  const start = match.index + match[0].length
  const json = extractJsonObject(html, start)

  if (!json) {
    return undefined
  }

  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

function extractJsonObject(text: string, startIndex: number): string | undefined {
  let objectStart = -1

  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === '{') {
      objectStart = index
      break
    }

    if (!/\s/.test(text[index] ?? '')) {
      return undefined
    }
  }

  if (objectStart < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && inString) {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1

      if (depth === 0) {
        return text.slice(objectStart, index + 1)
      }
    }
  }

  return undefined
}

function findMediaItem(input: unknown, expectedId: string): DouyinItem | undefined {
  const stack: unknown[] = [input]
  const visited = new Set<object>()

  while (stack.length > 0) {
    const current = stack.shift()

    if (!current || typeof current !== 'object') continue
    if (visited.has(current)) continue
    visited.add(current)

    if (Array.isArray(current)) {
      for (const value of current) {
        if (isMediaItem(value)) {
          const item = value as DouyinItem
          if (normalizeAwemeId(item.aweme_id) === expectedId) return item
        }

        if (value && typeof value === 'object') {
          stack.push(value)
        }
      }
      continue
    }

    const object = current as Record<string, unknown>

    for (const key of ['item_list', 'aweme_list']) {
      const list = object[key]
      if (!Array.isArray(list)) continue

      for (const value of list) {
        if (!isMediaItem(value)) continue

        const item = value as DouyinItem
        if (normalizeAwemeId(item.aweme_id) === expectedId) return item
      }
    }

    if (isMediaItem(object)) {
      const item = object as DouyinItem
      if (normalizeAwemeId(item.aweme_id) === expectedId) return item
    }

    for (const value of Object.values(object)) {
      if (value && typeof value === 'object') {
        stack.push(value)
      }
    }
  }

  return undefined
}

function pageMatchesExpectedVideo(
  responseUrl: string,
  html: string,
  expectedId: string,
): boolean {
  try {
    const resolvedId = extractDouyinVideoId(new URL(responseUrl))

    if (resolvedId) {
      return resolvedId === expectedId
    }
  } catch {
    // 继续检查页面内容。
  }

  const escapedId = escapeRegExp(expectedId)
  const patterns = [
    new RegExp("/(?:video|note|slides)/" + escapedId + "(?:[/?#\"']|$)"),
    new RegExp("/share/(?:video|note|slides)/" + escapedId + "(?:[/?#\"']|$)"),
    new RegExp('"aweme_id"\\s*:\\s*"' + escapedId + '"'),
    new RegExp('"itemId"\\s*:\\s*"' + escapedId + '"'),
    new RegExp("modal_id=" + escapedId + "(?:&|[\"']|$)"),
  ]

  return patterns.some((pattern) => pattern.test(html))
}

function isMediaItem(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false

  const item = input as Record<string, unknown>
  const video = item.video
  const imagePostInfo =
    item.image_post_info &&
    typeof item.image_post_info === 'object' &&
    !Array.isArray(item.image_post_info)
      ? (item.image_post_info as Record<string, unknown>)
      : undefined

  const hasVideo =
    !!video &&
    typeof video === 'object' &&
    !Array.isArray(video)

  const hasImages =
    (Array.isArray(item.images) && item.images.length > 0) ||
    (Array.isArray(item.image_list) && item.image_list.length > 0) ||
    (Array.isArray(imagePostInfo?.images) && imagePostInfo.images.length > 0) ||
    (Array.isArray(imagePostInfo?.image_list) && imagePostInfo.image_list.length > 0)

  return normalizeAwemeId(item.aweme_id) !== undefined && (hasVideo || hasImages)
}

function normalizeAwemeId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

function findFilterReason(input: unknown): string | undefined {
  const stack: unknown[] = [input]
  const visited = new Set<object>()

  while (stack.length > 0) {
    const current = stack.shift()

    if (!current || typeof current !== 'object') continue
    if (visited.has(current)) continue
    visited.add(current)

    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }

    const object = current as Record<string, unknown>

    for (const key of ['detail_msg', 'notice', 'filter_detail']) {
      const value = object[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }

    for (const value of Object.values(object)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }

  return undefined
}

function extractFirstUrl(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const value = normalizeUrl(input)
    return /^https?:\/\//i.test(value) ? value : undefined
  }

  if (Array.isArray(input)) {
    for (const value of input) {
      const url = extractFirstUrl(value)
      if (url) return url
    }
    return undefined
  }

  if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>

    for (const key of ['url_list', 'urlList', 'url', 'src']) {
      if (!(key in object)) continue

      const url = extractFirstUrl(object[key])
      if (url) return url
    }
  }

  return undefined
}

function extractLastUrl(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const value = normalizeUrl(input)
    return /^https?:\/\//i.test(value) ? value : undefined
  }

  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const url = extractLastUrl(input[index])
      if (url) return url
    }
    return undefined
  }

  if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>
    for (const key of ['url_list', 'urlList', 'url', 'src']) {
      if (!(key in object)) continue
      const url = extractLastUrl(object[key])
      if (url) return url
    }
  }

  return undefined
}
function toPlayableUrl(url: string): string {
  return url
    .replace('/playwm/', '/play/')
    .replace(/([?&])watermark=[^&]*/gi, '$1')
    .replace(/[?&]$/, '')
}

function buildWebDetailHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Origin: 'https://open.douyin.com',
    Referer: 'https://open.douyin.com/',
  }
}
function buildPageHeaders(): Record<string, string> {
  return {
    'User-Agent': MOBILE_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.douyin.com/',
  }
}

function extractMeta(html: string, key: string): string | undefined {
  const escapedKey = escapeRegExp(key)
  const patterns = [
    new RegExp(
      "<meta[^>]+(?:property|name)=[\"']" +
        escapedKey +
        "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
      'i',
    ),
    new RegExp(
      "<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" +
        escapedKey +
        "[\"'][^>]*>",
      'i',
    ),
  ]

  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1]
    if (value) return decodeHtmlEntities(value)
  }

  return undefined
}

function normalizeUrl(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
}
