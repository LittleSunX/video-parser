import type { ValidatedVideoInfo } from './video'

export type VideoContractIssue = 'resource' | 'size' | 'completeness' | 'status' | 'metadata'
type Validation =
  { valid: true; value: ValidatedVideoInfo } | { valid: false; issue: VideoContractIssue }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Additive wire contract: old optional fields may be absent; new unknown fields are retained. */
export function validateVideoInfo(data: unknown): Validation {
  const invalid = (issue: VideoContractIssue): Validation => ({ valid: false, issue })
  if (
    !record(data) ||
    typeof data.videoId !== 'string' ||
    typeof data.title !== 'string' ||
    typeof data.sourceUrl !== 'string' ||
    typeof data.platform !== 'string' ||
    !['douyin', 'kuaishou', 'xiaohongshu', 'tiktok', 'unknown'].includes(data.platform) ||
    (data.mediaType !== 'video' && data.mediaType !== 'image') ||
    (data.mediaType === 'video' && typeof data.videoUrl !== 'string') ||
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
          (image.livePhotoUrl === undefined || typeof image.livePhotoUrl === 'string') &&
          (image.watermarkFree === undefined || typeof image.watermarkFree === 'boolean'),
      ))
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
    ['author', 'cover', 'musicUrl', 'musicTitle', 'videoUrl'].some(
      (key) => data[key] !== undefined && typeof data[key] !== 'string',
    ) ||
    (data.duration !== undefined &&
      (typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration < 0))
  )
    return invalid('metadata')

  return { valid: true, value: data as unknown as ValidatedVideoInfo }
}
