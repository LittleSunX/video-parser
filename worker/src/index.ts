import { createDiagnostics, errorCode, mediaCounts, withDiagnostics } from './utils/diagnostics'
import type { Diagnostics } from './utils/diagnostics'
import { imageFilename } from '../../shared/media'
import { fetchMedia } from './services/media-download'
import { AppError } from './errors/app-error'
import { parseVideo } from './services/parse-service'
import { jsonResponse, notFoundResponse, optionsResponse } from './utils/response'

import { enforceRateLimit, type Env } from './utils/rate-limit'
import { readParseInput } from './utils/parse-input'
import { errorResponse } from './utils/error-response'
import { downloadErrorPage } from './utils/download-error-page'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const trace = createDiagnostics(env?.CF_VERSION_METADATA)
    const started = Date.now()
    const response = await routeRequest(request, env, trace)
    const path = new URL(request.url).pathname
    const operation =
      path === '/api/parse' ? 'parse' : path === '/api/download' ? 'download' : 'other'
    trace.emit('request_response', {
      operation,
      status: response.status,
      durationMs: Date.now() - started,
    })
    return withDiagnostics(response, trace)
  },
}

async function routeRequest(request: Request, env: Env, trace: Diagnostics): Promise<Response> {
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
        version: trace.version,
        versionTag: env?.CF_VERSION_METADATA?.tag ?? null,
        versionCreatedAt: env?.CF_VERSION_METADATA?.timestamp ?? null,
      },
    })
  }

  if (request.method === 'GET' && url.pathname === '/api/download') {
    return handleDownload(request, url, env, trace)
  }

  if (request.method === 'POST' && url.pathname === '/api/parse') {
    return handleParse(request, env, trace)
  }

  return notFoundResponse()
}

async function handleParse(request: Request, env: Env, trace: Diagnostics): Promise<Response> {
  try {
    await enforceRateLimit(request, env, 'parse')
    const input = await readParseInput(request)
    const video = await parseVideo(input, request.signal, trace)
    trace.emit('parse_result', mediaCounts(video))

    return jsonResponse({
      success: true,
      data: video,
    })
  } catch (error) {
    trace.emit('request_error', { code: errorCode(error) })
    return errorResponse(error, 'parse')
  }
}

async function handleDownload(
  request: Request,
  requestUrl: URL,
  env: Env,
  trace: Diagnostics,
): Promise<Response> {
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
    trace.emit('request_error', { code: errorCode(error) })
    const response = errorResponse(error, 'download')
    const token = requestUrl.searchParams.get('errorToken') ?? ''
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token))
      return downloadErrorPage(response, token, trace)
    return response
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
