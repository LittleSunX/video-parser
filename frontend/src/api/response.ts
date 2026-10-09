import type { VideoInfo } from '../types/video'

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
    throw new Error(httpMessage(response))
  }
  return readVideoPayload(payload, response)
}

/** JSON 与渐进结果使用相同的资源和状态校验。 */
export function readVideoPayload(payload: unknown, response: Response): VideoInfo {
  if (response.status === 429) throw new Error(httpMessage(response))
  if (!payload || typeof payload !== 'object') throw new Error(httpMessage(response))
  const result = payload as Record<string, unknown>
  if (result.success === false && result.error && typeof result.error === 'object') {
    const message = (result.error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim() && message.length <= 300)
      throw new Error(message)
  }
  if (!response.ok || result.success !== true || !result.data || typeof result.data !== 'object') {
    throw new Error(httpMessage(response))
  }
  const data = result.data as Record<string, unknown>
  if (
    typeof data.videoId !== 'string' ||
    typeof data.title !== 'string' ||
    typeof data.sourceUrl !== 'string' ||
    typeof data.platform !== 'string' ||
    !['douyin', 'kuaishou', 'xiaohongshu', 'tiktok', 'unknown'].includes(data.platform) ||
    (data.mediaType !== 'video' && data.mediaType !== 'image') ||
    (data.mediaType === 'video' && typeof data.videoUrl !== 'string') ||
    (data.mediaType === 'image' &&
      (!Array.isArray(data.images) ||
        !data.images.every(
          (image) => image && typeof image === 'object' && typeof image.url === 'string',
        )))
  ) {
    throw new Error('作品信息不完整，请重新解析')
  }
  const images = data.images as VideoInfo['images']
  if (
    data.imagesComplete !== undefined &&
    (typeof data.imagesComplete !== 'boolean' ||
      data.mediaType !== 'image' ||
      (data.imagesComplete && (!images?.length || !images.every((image) => image.url.trim()))))
  ) {
    throw new Error('作品资源状态异常，请重新解析')
  }
  if (
    (data.parseStatus !== undefined || data.parseReason !== undefined) &&
    !(
      (data.parseStatus === 'complete' && data.parseReason === 'complete') ||
      (data.parseStatus === 'unverified' &&
        (data.parseReason === 'timeout' || data.parseReason === 'exhausted'))
    )
  ) {
    throw new Error('作品解析状态异常，请重新解析')
  }
  return data as unknown as VideoInfo
}
