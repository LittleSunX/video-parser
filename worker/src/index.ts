import { AppError } from './errors/app-error'
import { parseVideo } from './services/parse-service'
import { jsonResponse, notFoundResponse, optionsResponse } from './utils/response'

import { enforceRateLimit, type Env } from './utils/rate-limit'
import { readParseInput } from './utils/parse-input'
import { errorResponse } from './utils/error-response'

const MEDIA_HOST_SUFFIXES = [
  'douyinvod.com',
  'douyinpic.com',
  'douyinstatic.com',
  'douyin.com',
  'iesdouyin.com',
  'byteimg.com',
  'bytecdn.cn',
  'bytedance.com',
  'snssdk.com',
  'amemv.com',
  'zjcdn.com',
  'volccdn.com',
  'byteicdn.com',
  'bytefcdnrd.com',
  'ibytedtos.com',
  'pstatp.com',
  'bytegecko.com',
]

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return optionsResponse()
    }

    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return jsonResponse({
        success: true,
        data: {
          service: 'video-parser-api',
          status: 'ok',
        },
      })
    }

    if (request.method === 'GET' && url.pathname === '/api/download') {
      return handleDownload(request, url, env)
    }

    if (request.method === 'POST' && url.pathname === '/api/parse') {
      return handleParse(request, env)
    }

    return notFoundResponse()
  },
}

async function handleParse(request: Request, env: Env): Promise<Response> {
  try {
    await enforceRateLimit(request, env, 'parse')
    const input = await readParseInput(request)
    const video = await parseVideo(input, request.signal)

    return jsonResponse({
      success: true,
      data: video,
    })
  } catch (error) {
    return errorResponse(error, 'parse')
  }
}

async function handleDownload(request: Request, requestUrl: URL, env: Env): Promise<Response> {
  try {
    await enforceRateLimit(request, env, 'download')
    const rawUrl = requestUrl.searchParams.get('url')
    const filename = sanitizeFilename(requestUrl.searchParams.get('filename') || 'download')

    if (!rawUrl) {
      throw new AppError('INVALID_INPUT', '缺少下载地址')
    }

    if (rawUrl.length > 8192) throw new AppError('INVALID_URL', '下载地址过长，请重新解析')

    let mediaUrl: URL

    try {
      mediaUrl = new URL(rawUrl)
    } catch {
      throw new AppError('INVALID_URL', '下载地址格式不正确')
    }

    const upstream = await fetchMedia(mediaUrl, request.headers.get('Range'))

    if ([401, 403, 404, 410].includes(upstream.status)) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media HTTP ' + upstream.status, 422)
    }
    if (upstream.status === 429) throw new AppError('UPSTREAM_BUSY', 'Media HTTP 429', 503)
    if (!upstream.ok && upstream.status !== 206) {
      throw new AppError('DOWNLOAD_FAILED', '媒体资源下载失败（HTTP ' + upstream.status + '）', 502)
    }

    const headers = new Headers()
    const contentType = upstream.headers.get('Content-Type')
    const contentLength = upstream.headers.get('Content-Length')
    const contentRange = upstream.headers.get('Content-Range')
    const acceptRanges = upstream.headers.get('Accept-Ranges')

    if (contentType) headers.set('Content-Type', contentType)
    if (contentLength) headers.set('Content-Length', contentLength)
    if (contentRange) headers.set('Content-Range', contentRange)
    if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)

    headers.set('Access-Control-Allow-Origin', '*')
    headers.set(
      'Content-Disposition',
      'attachment; filename="download"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
    )
    headers.set('Cache-Control', 'private, max-age=0, no-store')

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (error) {
    return errorResponse(error, 'download')
  }
}

async function fetchMedia(initialUrl: URL, range: string | null): Promise<Response> {
  let current = initialUrl

  for (let index = 0; index < 6; index += 1) {
    validateMediaUrl(current)

    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Referer: 'https://www.douyin.com/',
      Accept: '*/*',
    }

    if (range) headers.Range = range

    const response = await fetch(current.toString(), {
      headers,
      redirect: 'manual',
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }

    const location = response.headers.get('Location')
    if (!location) return response

    current = new URL(location, current)
  }

  throw new AppError('DOWNLOAD_FAILED', '媒体资源重定向次数过多', 502)
}

function validateMediaUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', '仅支持 HTTPS 媒体地址')
  }

  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('INVALID_URL', '链接不能包含登录信息或自定义端口')
  }

  const hostname = url.hostname.toLowerCase()
  const allowed = MEDIA_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith('.' + suffix),
  )

  if (!allowed) {
    throw new AppError('INVALID_URL', '该媒体地址不在允许的下载域名中')
  }
}

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)

  return cleaned || 'download'
}
