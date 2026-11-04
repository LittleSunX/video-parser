import { extractDouyinVideoId } from '../../utils/douyin-id'
import { decodeHtmlEntities } from './text'
import { normalizeAwemeId } from './items'

export function extractRouterData(html: string): unknown | undefined {
  return routerDataValues(html)[0]
}

function routerDataValues(html: string): unknown[] {
  const values: unknown[] = []
  // Match whole comments before scripts, so commented-out scripts cannot establish identity.
  const blocks =
    /<!--[\s\S]*?(?:-->|$)|<script\b(?:[^"'<>]|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\s*>/gi
  for (const block of html.matchAll(blocks)) {
    const script = block[1]
    if (script === undefined) continue
    const code = scriptCode(script)
    const marker = /\bwindow\s*\.\s*_ROUTER_DATA\s*=\s*/g
    for (const match of code.matchAll(marker)) {
      const previous = code.slice(0, match.index).trimEnd().at(-1)
      if (previous && /[\w$.]/.test(previous)) continue
      const json = extractJsonObject(script, match.index + match[0].length)
      if (!json) continue
      try {
        values.push(JSON.parse(json))
      } catch {
        /* A malformed assignment does not establish a current item. */
      }
    }
  }
  return values
}

/** Hide inert JS text while retaining JSON offsets; do not mistake division for a regex. */
function scriptCode(script: string): string {
  const code = script.split('')
  const parentheses: boolean[] = []
  let regexAllowed = true
  let previousWord = ''
  let index = 0
  while (index < script.length) {
    const start = index
    const char = script[index++]
    if (/\s/.test(char)) continue
    if (char === '/' && (script[index] === '/' || script[index] === '*')) {
      const line = script[index++] === '/'
      while (index < script.length) {
        if (line && /[\r\n]/.test(script[index])) break
        if (!line && script[index] === '*' && script[index + 1] === '/') {
          index += 2
          break
        }
        index++
      }
      code.fill(' ', start, index)
      continue
    }
    if (char === '"' || char === "'" || char === '`' || (char === '/' && regexAllowed)) {
      const regex = char === '/'
      let inClass = false
      while (index < script.length) {
        const next = script[index++]
        if (next === '\\') index++
        else if (regex && next === '[') inClass = true
        else if (regex && next === ']') inClass = false
        else if (next === char && !inClass) break
      }
      if (regex) while (/[a-z]/i.test(script[index] ?? '') && index < script.length) index++
      code.fill(' ', start, Math.min(index, script.length))
      regexAllowed = false
      previousWord = ''
      continue
    }
    if (/[\w$]/.test(char)) {
      while (/[\w$]/.test(script[index] ?? '') && index < script.length) index++
      previousWord = script.slice(start, index)
      regexAllowed =
        /^(?:return|throw|case|delete|void|typeof|new|in|instanceof|yield|await|else|do)$/.test(
          previousWord,
        )
      continue
    }
    if (char === '(') {
      parentheses.push(/^(?:if|while|for|with|switch|catch)$/.test(previousWord))
      regexAllowed = true
    } else if (char === ')') regexAllowed = parentheses.pop() ?? false
    else if (char === ']' || char === '.') regexAllowed = false
    else if ((char === '+' || char === '-') && script[index] === char) index++
    else regexAllowed = true
    previousWord = ''
  }
  return code.join('')
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
  const pageIds = currentPageIds(html, responseUrl)
  if (pageIds.some((id) => id !== expectedId)) return false
  if (resolvedId === expectedId || pageIds.includes(expectedId)) return true

  // Preserve link-only metadata pages, without treating arbitrary recommendation JSON as identity.
  const links = withoutScriptsAndComments(html).match(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? []
  return links.some((tag) => pageUrlId(tagAttribute(tag, 'href') ?? '', responseUrl) === expectedId)
}

/** Unknown short links need one unambiguous current identity, never a recommended link/item. */
export function currentPageVideoId(html: string, responseUrl: string): string | undefined {
  const ids = new Set(currentPageIds(html, responseUrl))
  return ids.size === 1 ? ids.values().next().value : undefined
}

function currentPageIds(html: string, responseUrl: string): string[] {
  return [
    ...metadataPageIds(html, responseUrl),
    ...routerDataValues(html).flatMap(currentRouterIds),
  ]
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
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<script\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/script\s*>|$)/gi,
    '',
  )
}

function tagAttribute(tag: string, name: string): string | undefined {
  const attributes = tag.replace(/^<[^\s>]+/, '')
  // Consume entire attribute values, including quoted text resembling another attribute.
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === name.toLowerCase()) {
      const value = match[2] ?? match[3] ?? match[4]
      return value === undefined ? undefined : decodeHtmlEntities(value)
    }
  }
  return undefined
}

function metadataPageIds(html: string, responseUrl: string): string[] {
  const document = withoutScriptsAndComments(html)
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(document)?.[1] ?? document
  const tags = head.match(/<(?:meta|link)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? []
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
  const tags = withoutScriptsAndComments(html).match(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi) ?? []
  for (const tag of tags) {
    if (
      ![tagAttribute(tag, 'property'), tagAttribute(tag, 'name')].some(
        (name) => name?.toLowerCase() === key.toLowerCase(),
      )
    )
      continue
    const value = tagAttribute(tag, 'content')
    if (value) return value
  }

  return undefined
}
