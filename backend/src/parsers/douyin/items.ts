import type { DouyinItem } from './types'
import { AppError } from '../../errors/app-error'

// 字节上限之外，再限制结构扫描量；包括节点出队、数组成员和对象属性检查。
export const MAX_ITEM_SEARCH_STEPS = 500_000

/** 保持广度优先顺序，避免 shift() 搬移宽队列和展开数组导致参数栈溢出。 */
function createObjectSearch(input: unknown) {
  const queue: Array<object | undefined> = []
  const seen = new WeakSet<object>()
  let cursor = 0
  let steps = 0
  function check() {
    if (++steps > MAX_ITEM_SEARCH_STEPS)
      throw new AppError('UPSTREAM_STRUCTURE_TOO_COMPLEX', '上游数据结构过于复杂', 502)
  }
  function enqueue(value: unknown) {
    check()
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    queue.push(value)
  }
  function next() {
    if (cursor >= queue.length) return
    check()
    const value = queue[cursor]
    queue[cursor++] = undefined
    return value
  }
  enqueue(input)
  return { enqueue, next, check }
}

export function findMediaItem(input: unknown, expectedId: string): DouyinItem | undefined {
  const search = createObjectSearch(input)

  for (let current = search.next(); current; current = search.next()) {
    if (Array.isArray(current)) {
      for (const value of current) {
        search.enqueue(value)
        if (isMediaItem(value)) {
          const item = value as DouyinItem
          if (normalizeAwemeId(item.aweme_id) === expectedId) return item
        }
      }
      continue
    }

    const object = current as Record<string, unknown>

    for (const key of ['item_list', 'aweme_list']) {
      const list = object[key]
      if (!Array.isArray(list)) continue

      for (const value of list) {
        search.check()
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
      search.enqueue(value)
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
  const search = createObjectSearch(input)

  for (let current = search.next(); current; current = search.next()) {
    if (Array.isArray(current)) {
      for (const value of current) search.enqueue(value)
      continue
    }

    const object = current as Record<string, unknown>

    for (const key of ['detail_msg', 'notice', 'filter_detail']) {
      const value = object[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }

    for (const value of Object.values(object)) {
      search.enqueue(value)
    }
  }

  return undefined
}
