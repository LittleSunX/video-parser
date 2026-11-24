import { isSafeHttpUrl } from '../../../../shared/video-contract'

/** 优先使用上游已有的 HTTPS 候选，过滤无效地址，不改写仅有 HTTP 的签名地址。 */
export function extractFirstUrl(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const value = normalizeUrl(input).trim()
    return isSafeHttpUrl(value) ? value : undefined
  }

  if (Array.isArray(input)) {
    let fallback: string | undefined
    for (const value of input) {
      const url = extractFirstUrl(value)
      if (url && isSafeHttpUrl(url, true)) return url
      fallback ??= url
    }
    return fallback
  }

  if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>
    let fallback: string | undefined

    for (const key of ['url_list', 'urlList', 'url', 'src']) {
      if (!(key in object)) continue

      const url = extractFirstUrl(object[key])
      if (url && isSafeHttpUrl(url, true)) return url
      fallback ??= url
    }
    return fallback
  }

  return undefined
}

/** Collect a bounded set of existing HTTPS alternatives without changing signed addresses. */
export function extractHttpsUrls(input: unknown, limit: number): string[] {
  const urls = new Set<string>()
  function collect(value: unknown): void {
    if (urls.size >= limit) return
    if (typeof value === 'string') {
      const url = normalizeUrl(value).trim()
      if (isSafeHttpUrl(url, true)) urls.add(url)
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item)
    } else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      for (const key of ['url_list', 'urlList', 'url', 'src']) collect(object[key])
    }
  }
  collect(input)
  return [...urls]
}

export function toPlayableUrl(url: string): string {
  const hashIndex = url.indexOf('#')
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const queryIndex = withoutHash.indexOf('?')
  const base = (queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash).replace(
    '/playwm/',
    '/play/',
  )
  if (queryIndex < 0) return base + hash
  const rawQuery = withoutHash.slice(queryIndex + 1)
  const parts = rawQuery.split('&')
  const isWatermarkParam = (part: string) => /^watermark(?:=|$)/i.test(part)
  if (!parts.some(isWatermarkParam)) return `${base}?${rawQuery}${hash}`
  const remaining = parts.filter((part) => !isWatermarkParam(part))
  return (remaining.length ? `${base}?${remaining.join('&')}` : base) + hash
}

export function normalizeUrl(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
}

export function normalizeText(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim()
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  '#39': "'",
  '#x27': "'",
  lt: '<',
  gt: '>',
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(amp|quot|#39|#x27|lt|gt);/gi,
    (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match,
  )
}

export function readNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  return 0
}
