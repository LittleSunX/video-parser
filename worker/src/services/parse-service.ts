import { AppError } from '../errors/app-error'
import { findParser } from '../parsers'
import type { VideoInfo } from '../types/video'
import { extractUrl, resolveSupportedUrl, validateSupportedUrl } from '../utils/url'

export async function parseVideo(input: string, clientSignal?: AbortSignal): Promise<VideoInfo> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('解析超时', 'TimeoutError')), 30000)
  const signal = clientSignal ? AbortSignal.any([clientSignal, controller.signal]) : controller.signal
  try {
    const result = await parseWithSignal(input, signal)
    clientSignal?.throwIfAborted()
    return result
  } catch (error) {
    if (signal.aborted) {
      if (clientSignal?.aborted) throw new AppError('REQUEST_CANCELLED', '解析已取消', 499)
      throw new AppError('PARSE_TIMEOUT', '解析超时，请稍后重试', 504)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function parseWithSignal(input: string, signal: AbortSignal): Promise<VideoInfo> {
  signal.throwIfAborted()
  const sourceUrl = extractUrl(input)
  validateSupportedUrl(sourceUrl)

  const resolvedUrl = await resolveSupportedUrl(sourceUrl, signal)
  validateSupportedUrl(resolvedUrl)

  const parser = findParser(resolvedUrl.toString())

  if (!parser) {
    throw new AppError('UNSUPPORTED_PLATFORM', '暂不支持该视频平台')
  }

  return parser.parse(resolvedUrl.toString(), signal)
}
