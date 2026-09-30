import { imageFilename } from '../../shared/media'
import { fetchMedia } from './services/media-download'
import { AppError } from './errors/app-error'
import { parseVideo } from './services/parse-service'
import { jsonResponse, notFoundResponse, optionsResponse } from './utils/response'

import { enforceRateLimit, type Env } from './utils/rate-limit'
import { readParseInput } from './utils/parse-input'
import { errorResponse } from './utils/error-response'

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

    const upstream = await fetchMedia(mediaUrl, request.headers.get('Range'), request.signal)

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
    headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
    if (upstream.status !== 416)
      headers.set(
        'Content-Disposition',
        'attachment; filename="download"; filename*=UTF-8\'\'' +
          encodeURIComponent(imageFilename(filename, contentType)),
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

function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)

  return cleaned || 'download'
}
