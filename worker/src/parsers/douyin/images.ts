import type { VideoInfo, ImageAsset } from '../../types/video'
import type { ParsedMediaResult } from './types'
import { normalizeUrl, extractFirstUrl, toPlayableUrl } from './text'

export function extractImageAssets(input: unknown): ImageAsset[] {
  if (!Array.isArray(input)) {
    return []
  }

  const assets: ImageAsset[] = []
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

export interface ImageUrlCandidate {
  url: string
  source: string
  rank: number
  watermarkFree: boolean
}

export function selectBestImageUrl(image: Record<string, unknown>): ImageUrlCandidate | undefined {
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

export function extractAllUrls(input: unknown): string[] {
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

export function isWatermarkedMediaUrl(url: string): boolean {
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

export function imageFormatRank(url: string): number {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return url.toLowerCase()
    }
  })()

  return path.includes('.webp') ? 1 : 0
}

export function scoreImageResult(result: VideoInfo): number {
  const images = result.images ?? []
  const liveCount = images.filter((image) => !!image.livePhotoUrl).length
  const cleanCount = images.filter((image) => image.watermarkFree).length
  return liveCount * 10000 + cleanCount * 100 + images.length
}

export function isHighConfidenceImageResult(result: ParsedMediaResult): boolean {
  const images = result.video.images ?? []
  if (images.length === 0) return false
  const allClean = images.every((image) => image.watermarkFree || !image.url)
  return allClean && result.imagesComplete
}

export function extractLivePhotoUrl(image: Record<string, unknown>): string | undefined {
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

export function extractUri(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const uri = (input as Record<string, unknown>).uri
  return typeof uri === 'string' && uri.trim() ? uri.trim() : undefined
}

export function buildLivePhotoPlayUrl(videoId: string): string {
  return (
    'https://www.iesdouyin.com/aweme/v1/play/?video_id=' +
    encodeURIComponent(videoId) +
    '&ratio=1080p&line=0&is_play_url=1&watermark=0&source=PackSourceEnum_PUBLISH'
  )
}
