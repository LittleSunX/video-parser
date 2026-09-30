import { AppError } from '../errors/app-error'

const SUPPORTED_HOST_SUFFIXES = ['douyin.com', 'iesdouyin.com']

export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

export function extractUrl(input: string): URL {
  const match = input.match(/https?:\/\/[^\s<>"']+/i)

  if (!match) {
    throw new AppError('INVALID_URL', '没有找到有效的视频链接')
  }

  const cleaned = match[0].replace(/[，。；！？、）】》」』),.;!?]+$/g, '')

  try {
    return new URL(cleaned)
  } catch {
    throw new AppError('INVALID_URL', '视频链接格式不正确')
  }
}

export function validateSupportedUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', '仅支持 HTTPS 链接')
  }

  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('INVALID_URL', '链接不能包含登录信息或自定义端口')
  }

  const hostname = url.hostname.toLowerCase()
  const allowed = SUPPORTED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith('.' + suffix),
  )

  if (!allowed) {
    throw new AppError('UNSUPPORTED_PLATFORM', '当前第一版仅支持抖音链接')
  }
}

export async function resolveSupportedUrl(inputUrl: URL, signal?: AbortSignal): Promise<URL> {
  let current = inputUrl

  for (let index = 0; index < 10; index += 1) {
    signal?.throwIfAborted()
    validateSupportedUrl(current)

    // 一旦 URL 中已经带有作品 ID，就不需要继续请求跳转。
    if (extractDouyinVideoId(current)) {
      return current
    }

    let response: Response

    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': MOBILE_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      })
    } catch {
      signal?.throwIfAborted()
      throw new AppError('URL_RESOLVE_FAILED', '展开分享链接失败，请稍后重试', 502)
    }

    try {
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.ok) {
          const html = await response.text()
          const videoId = extractDouyinVideoIdFromHtml(html)

          if (videoId) {
            return new URL('https://www.iesdouyin.com/share/video/' + videoId)
          }
        }

        return current
      }

      const location = response.headers.get('location')

      if (!location) {
        return current
      }

      current = new URL(location, current)
    } finally {
      // 取消未消费的响应，不等待远端清理完成，以免拖延下一跳。
      if (!response.bodyUsed) void response.body?.cancel().catch(() => {})
    }
  }

  throw new AppError('URL_RESOLVE_FAILED', '分享链接重定向次数过多', 502)
}

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

  return (
    url.searchParams.get('modal_id') ??
    url.searchParams.get('aweme_id') ??
    url.searchParams.get('video_id') ??
    undefined
  )
}

function extractDouyinVideoIdFromHtml(html: string): string | undefined {
  const patterns = [
    /"aweme_id"\s*:\s*"(\d+)"/,
    /"itemId"\s*:\s*"(\d+)"/,
    /\/share\/(?:video|note|slides)\/(\d+)/,
    /\/(?:video|note|slides)\/(\d+)/,
    /modal_id=(\d+)/,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return match[1]
  }

  return undefined
}
