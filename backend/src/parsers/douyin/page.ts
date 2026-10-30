import { extractDouyinVideoId } from '../../utils/url'
import { escapeRegExp, decodeHtmlEntities } from './text'
import { normalizeAwemeId } from './items'

export function extractRouterData(html: string): unknown | undefined {
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

export function extractJsonObject(text: string, startIndex: number): string | undefined {
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

export function pageMatchesExpectedVideo(
  responseUrl: string,
  html: string,
  expectedId: string,
): boolean {
  const resolvedId = pageUrlId(responseUrl)
  if (resolvedId && resolvedId !== expectedId) return false

  // A URL that still contains the requested ID cannot overrule a different current item.
  const pageIds = [
    ...metadataPageIds(html, responseUrl),
    ...currentRouterIds(extractRouterData(html)),
  ]
  if (pageIds.some((id) => id !== expectedId)) return false
  if (resolvedId === expectedId || pageIds.includes(expectedId)) return true

  // Preserve link-only metadata pages, without treating arbitrary recommendation JSON as identity.
  const links = withoutScriptsAndComments(html).match(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? []
  return links.some((tag) => pageUrlId(tagAttribute(tag, 'href') ?? '', responseUrl) === expectedId)
}

function pageUrlId(value: string, base = 'https://www.douyin.com'): string | undefined {
  if (!value.trim()) return undefined
  try {
    const url = new URL(decodeHtmlEntities(value), base || 'https://www.douyin.com')
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)(douyin|iesdouyin)\.com$/i.test(url.hostname))
      return undefined
    return normalizeAwemeId(extractDouyinVideoId(url))
  } catch {
    return undefined
  }
}

function withoutScriptsAndComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
}

function tagAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(
    '(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))',
    'i',
  )
  const match = pattern.exec(tag)
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3]) : undefined
}

function metadataPageIds(html: string, responseUrl: string): string[] {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html)?.[1] ?? html
  const tags =
    withoutScriptsAndComments(head).match(/<(?:meta|link)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? []
  const ids: string[] = []
  for (const tag of tags) {
    let value: string | undefined
    if (
      /^<link\b/i.test(tag) &&
      tagAttribute(tag, 'rel')?.toLowerCase().split(/\s+/).includes('canonical')
    )
      value = tagAttribute(tag, 'href')
    if (
      /^<meta\b/i.test(tag) &&
      [tagAttribute(tag, 'property'), tagAttribute(tag, 'name')].some(
        (name) => name?.toLowerCase() === 'og:url',
      )
    )
      value = tagAttribute(tag, 'content')
    const id = value ? pageUrlId(value, responseUrl) : undefined
    if (id) ids.push(id)
  }
  return ids
}

function currentRouterIds(input: unknown): string[] {
  const pending = [input]
  const visited = new Set<object>()
  const ids: string[] = []
  while (pending.length) {
    const current = pending.pop()
    if (!current || typeof current !== 'object' || Array.isArray(current) || visited.has(current))
      continue
    visited.add(current)
    const item = current as Record<string, unknown>
    for (const field of ['aweme_id', 'itemId']) {
      const id = normalizeAwemeId(item[field])
      if (id) ids.push(id)
    }
    // Only follow current-detail wrappers; recommendations and generic lists are not page identity.
    for (const field of [
      'aweme_detail',
      'awemeDetail',
      'awemeInfo',
      'itemInfo',
      'itemStruct',
      'data',
    ])
      pending.push(item[field])
    for (const field of ['videoInfoRes', 'noteInfoRes', 'slidesInfoRes']) {
      const detail = item[field]
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue
      pending.push(detail)
      const list = (detail as Record<string, unknown>).item_list
      if (Array.isArray(list)) pending.push(list[0])
    }
    const loader = item.loaderData
    if (loader && typeof loader === 'object' && !Array.isArray(loader))
      for (const [route, value] of Object.entries(loader))
        if (/^(?:video|note|slides)(?:_|\/)/i.test(route)) pending.push(value)
  }
  return ids
}

export function extractMeta(html: string, key: string): string | undefined {
  const escapedKey = escapeRegExp(key)
  const patterns = [
    new RegExp(
      '<meta[^>]+(?:property|name)=["\']' +
        escapedKey +
        '["\'][^>]+content=["\']([^"\']+)["\'][^>]*>',
      'i',
    ),
    new RegExp(
      '<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' +
        escapedKey +
        '["\'][^>]*>',
      'i',
    ),
  ]

  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1]
    if (value) return decodeHtmlEntities(value)
  }

  return undefined
}
