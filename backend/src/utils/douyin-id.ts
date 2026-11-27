/** URL identity only; HTML callers must establish that a URL belongs to the current page. */
export function extractDouyinVideoId(url: URL): string | undefined {
  const patterns = [
    /\/share\/(?:video|note|slides)\/(\d+)/,
    /\/(?:video|note|slides)\/(\d+)/,
    /\/aweme\/detail\/(\d+)/,
  ]

  for (const pattern of patterns) {
    const match = url.pathname.match(pattern)
    if (match?.[1]) return match[1]
  }

  for (const name of ['modal_id', 'aweme_id', 'video_id']) {
    const id = url.searchParams.getAll(name).find((value) => /^\d+$/.test(value))
    if (id) return id
  }
  return undefined
}
