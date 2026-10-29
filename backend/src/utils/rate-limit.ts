import { AppError } from '../errors/app-error'
import type { ApiOperation, ApiRuntime, RateLimitResult } from '../http/runtime'

export async function enforceRateLimit(
  runtime: ApiRuntime,
  clientId: string,
  operation: ApiOperation,
): Promise<void> {
  let result: RateLimitResult
  try {
    result = await runtime.rateLimit(operation, clientId)
  } catch {
    throw new AppError('SERVICE_UNAVAILABLE', '服务暂不可用，请稍后重试', 503)
  }
  if (result?.status === 'allowed') return
  if (
    result?.status === 'limited' &&
    Number.isSafeInteger(result.retryAfter) &&
    result.retryAfter > 0
  ) {
    throw new AppError(
      'RATE_LIMITED',
      operation === 'parse' ? '解析请求过于频繁，请稍后重试' : '下载请求过于频繁，请稍后重试',
      429,
      result.retryAfter,
    )
  }
  throw new AppError('SERVICE_UNAVAILABLE', '服务暂不可用，请稍后重试', 503)
}
