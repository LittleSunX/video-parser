import { AppError } from '../errors/app-error'
import { jsonResponse } from './response'

const PUBLIC_MESSAGES: Record<string, string> = {
  URL_RESOLVE_FAILED: '分享链接暂时无法打开，请从抖音重新复制链接后重试',
  VIDEO_NOT_FOUND: '未能识别目标作品，请粘贴具体作品的分享链接',
  VIDEO_ID_MISMATCH: '返回的作品信息不匹配，请重新复制目标作品链接',
  VIDEO_RESOURCE_NOT_FOUND: '暂时无法获取作品资源，请确认原作品可公开访问后重试',
  PARSE_FAILED: '作品暂时解析失败，请稍后重试或重新复制分享链接',
  REQUEST_FAILED: '暂时无法连接作品平台，请稍后重试',
  DOWNLOAD_TIMEOUT: '下载响应超时，请稍后重试',
  DOWNLOAD_NETWORK_ERROR: '下载连接中断，请检查网络后重试',
  DOWNLOAD_CANCELLED: '下载已取消',
  DOWNLOAD_FAILED: '暂时无法下载该资源，请重新解析后重试',
  MEDIA_UNAVAILABLE: '资源已失效或不可访问，请重新解析后下载',
  UPSTREAM_BUSY: '作品平台暂时繁忙，请稍后重新解析',
}

export function errorResponse(error: unknown, operation: 'parse' | 'download'): Response {
  if (error instanceof AppError) {
    const message = PUBLIC_MESSAGES[error.code] ?? error.message
    if (message !== error.message || error.status >= 500) {
      console.warn('API error:', operation, error.code, error.message)
    }
    return jsonResponse(
      { success: false, error: { code: error.code, message } },
      error.status,
      error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined,
    )
  }
  console.error('Unexpected API error:', operation, error)
  return jsonResponse(
    {
      success: false,
      error: {
        code: operation === 'parse' ? 'PARSE_FAILED' : 'DOWNLOAD_FAILED',
        message:
          operation === 'parse' ? PUBLIC_MESSAGES.PARSE_FAILED : PUBLIC_MESSAGES.DOWNLOAD_FAILED,
      },
    },
    500,
  )
}
