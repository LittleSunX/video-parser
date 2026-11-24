import type { ValidatedVideoInfo } from './video'
import { MAX_VIDEO_URL_ALTERNATIVES } from './video'

export type VideoContractIssue = 'resource' | 'size' | 'completeness' | 'status' | 'metadata'
type Validation =
  { valid: true; value: ValidatedVideoInfo } | { valid: false; issue: VideoContractIssue }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 校验明确的绝对 HTTP(S) URL：必须含双斜杠与主机名，不含空白、控制字符、反斜杠或凭据。 */
export function isSafeHttpUrl(value: unknown, httpsOnly = false): boolean {
  if (typeof value !== 'string' || !/^https?:\/\/[^/\\?#]+/i.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f) return false
  }
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0] ?? ''
  if (!authority || authority.includes('@') || authority.includes('\\')) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:')) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

/** Additive wire contract: old optional fields may be absent; new unknown fields are retained. */
export function validateVideoInfo(data: unknown): Validation {
  const invalid = (issue: VideoContractIssue): Validation => ({ valid: false, issue })
  if (
    !record(data) ||
    typeof data.videoId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(data.videoId) ||
    typeof data.title !== 'string' ||
    !isSafeHttpUrl(data.sourceUrl) ||
    typeof data.platform !== 'string' ||
    !['douyin', 'kuaishou', 'xiaohongshu', 'tiktok', 'unknown'].includes(data.platform) ||
    (data.mediaType !== 'video' && data.mediaType !== 'image') ||
    (data.mediaType === 'video' && !isSafeHttpUrl(data.videoUrl)) ||
    (data.mediaType === 'image' && !Array.isArray(data.images))
  )
    return invalid('resource')

  if (
    data.images !== undefined &&
    (!Array.isArray(data.images) ||
      !data.images.every(
        (image) =>
          record(image) &&
          typeof image.url === 'string' &&
          (image.url === '' || isSafeHttpUrl(image.url)) &&
          (image.livePhotoUrl === undefined || isSafeHttpUrl(image.livePhotoUrl)) &&
          (image.watermarkFree === undefined || typeof image.watermarkFree === 'boolean'),
      ))
  )
    return invalid('resource')

  if (
    data.videoUrlAlternatives !== undefined &&
    (!Array.isArray(data.videoUrlAlternatives) ||
      data.videoUrlAlternatives.length > MAX_VIDEO_URL_ALTERNATIVES ||
      !data.videoUrlAlternatives.every((url) => isSafeHttpUrl(url, true)) ||
      (data.videoUrlAlternatives.length > 0 && data.mediaType !== 'video'))
  )
    return invalid('resource')

  if (
    data.videoSize !== undefined &&
    (data.mediaType !== 'video' ||
      typeof data.videoSize !== 'number' ||
      !Number.isSafeInteger(data.videoSize) ||
      data.videoSize <= 0)
  )
    return invalid('size')

  if (
    data.imagesComplete !== undefined &&
    (typeof data.imagesComplete !== 'boolean' ||
      data.mediaType !== 'image' ||
      (data.imagesComplete &&
        (!Array.isArray(data.images) ||
          !data.images.length ||
          !data.images.every((image) => image.url.trim()))))
  )
    return invalid('completeness')

  if (
    (data.parseStatus !== undefined || data.parseReason !== undefined) &&
    !(
      (data.parseStatus === 'complete' && data.parseReason === 'complete') ||
      (data.parseStatus === 'unverified' &&
        (data.parseReason === 'timeout' || data.parseReason === 'exhausted'))
    )
  )
    return invalid('status')

  if (
    ['author', 'musicTitle'].some(
      (key) => data[key] !== undefined && typeof data[key] !== 'string',
    ) ||
    ['cover', 'musicUrl', 'videoUrl'].some(
      (key) => data[key] !== undefined && !isSafeHttpUrl(data[key]),
    ) ||
    (data.duration !== undefined &&
      (typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration < 0))
  )
    return invalid('metadata')

  return { valid: true, value: data as unknown as ValidatedVideoInfo }
}
