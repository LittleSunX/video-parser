import type { DouyinItem } from './types'

export function findMediaItem(input: unknown, expectedId: string): DouyinItem | undefined {
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

export function isMediaItem(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false

  const item = input as Record<string, unknown>
  const video = item.video
  const imagePostInfo =
    item.image_post_info &&
    typeof item.image_post_info === 'object' &&
    !Array.isArray(item.image_post_info)
      ? (item.image_post_info as Record<string, unknown>)
      : undefined

  const hasVideo = !!video && typeof video === 'object' && !Array.isArray(video)

  const hasImages =
    (Array.isArray(item.images) && item.images.length > 0) ||
    (Array.isArray(item.image_list) && item.image_list.length > 0) ||
    (Array.isArray(imagePostInfo?.images) && imagePostInfo.images.length > 0) ||
    (Array.isArray(imagePostInfo?.image_list) && imagePostInfo.image_list.length > 0)

  return normalizeAwemeId(item.aweme_id) !== undefined && (hasVideo || hasImages)
}

export function normalizeAwemeId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

export function findFilterReason(input: unknown): string | undefined {
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
