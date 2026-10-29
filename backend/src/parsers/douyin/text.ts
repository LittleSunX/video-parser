export function extractFirstUrl(input: unknown): string | undefined {
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

export function toPlayableUrl(url: string): string {
  return url
    .replace('/playwm/', '/play/')
    .replace(/([?&])watermark=[^&]*/gi, '$1')
    .replace(/[?&]$/, '')
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

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
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
