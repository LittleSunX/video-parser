import { extractDouyinVideoId } from '../../utils/url'
import { escapeRegExp, decodeHtmlEntities } from './text'

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
    new RegExp('/(?:video|note|slides)/' + escapedId + '(?:[/?#"\']|$)'),
    new RegExp('/share/(?:video|note|slides)/' + escapedId + '(?:[/?#"\']|$)'),
    new RegExp('"aweme_id"\\s*:\\s*"' + escapedId + '"'),
    new RegExp('"itemId"\\s*:\\s*"' + escapedId + '"'),
    new RegExp('modal_id=' + escapedId + '(?:&|["\']|$)'),
  ]

  return patterns.some((pattern) => pattern.test(html))
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
