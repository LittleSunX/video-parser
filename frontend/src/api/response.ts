import { validateVideoInfo, type VideoContractIssue } from '../../../shared/video-contract'
import type { VideoInfo } from '../types/video'
import { ParseError } from './parse-error'

function httpMessage(response: Response): string {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'))
    return Number.isFinite(seconds) && seconds > 0
      ? '请求过于频繁，请等待约 ' + Math.ceil(Math.min(seconds, 3600)) + ' 秒后重试'
      : '请求过于频繁，请稍后重试'
  }
  if (response.status === 413) return '输入内容过长，请只粘贴作品分享链接'
  if (response.status === 504) return '解析超时，请稍后重试'
  if (response.status >= 500) return '解析服务暂不可用，请稍后重试'
  return '解析服务返回异常，请刷新页面后重试'
}

export async function readVideoResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<VideoInfo> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    signal?.throwIfAborted()
    throw new ParseError('INVALID_RESPONSE', httpMessage(response))
  }
  return readVideoPayload(payload, response)
}

/** JSON 与渐进结果使用相同的资源和状态校验。 */
export function readVideoPayload(payload: unknown, response: Response): VideoInfo {
  if (response.status === 429) throw new ParseError('RATE_LIMITED', httpMessage(response))
  if (!payload || typeof payload !== 'object')
    throw new ParseError('INVALID_RESPONSE', httpMessage(response))
  const result = payload as Record<string, unknown>
  if (result.success === false && result.error && typeof result.error === 'object') {
    const message = (result.error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim() && message.length <= 300)
      throw new ParseError((result.error as Record<string, unknown>).code, message)
  }
  if (!response.ok || result.success !== true || !result.data || typeof result.data !== 'object') {
    throw new ParseError('HTTP_ERROR', httpMessage(response))
  }
  const validation = validateVideoInfo(result.data)
  if (!validation.valid) {
    const messages: Record<VideoContractIssue, string> = {
      resource: '作品信息不完整，请重新解析',
      size: '视频大小信息异常，请重新解析',
      completeness: '作品资源状态异常，请重新解析',
      status: '作品解析状态异常，请重新解析',
      metadata: '作品元信息格式异常，请重新解析',
    }
    throw new ParseError('INVALID_RESPONSE', messages[validation.issue])
  }
  return validation.value
}
