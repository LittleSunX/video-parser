import { AppError } from '../errors/app-error'

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  PARSE_RATE_LIMITER: RateLimiter
  DOWNLOAD_RATE_LIMITER: RateLimiter
}

export async function enforceRateLimit(request: Request, env: Env, kind: 'parse' | 'download'): Promise<void> {
  const limiter = kind === 'parse' ? env?.PARSE_RATE_LIMITER : env?.DOWNLOAD_RATE_LIMITER
  if (!limiter) {
    console.error('Missing rate limit binding:', kind)
    throw new AppError('SERVICE_UNAVAILABLE', '服务暂不可用，请稍后重试', 503)
  }
  // 此请求头由 Cloudflare 设置；不使用用户可修改的 X-Forwarded-For。
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  let success: boolean
  try {
    success = (await limiter.limit({ key: 'video-parser:' + kind + ':' + ip })).success
  } catch (error) {
    console.error('Rate limiter failed:', kind, error)
    throw new AppError('SERVICE_UNAVAILABLE', '服务暂不可用，请稍后重试', 503)
  }
  if (!success) {
    throw new AppError('RATE_LIMITED', kind === 'parse'
      ? '解析请求过于频繁，请等待约 60 秒后重试'
      : '下载请求过于频繁，请等待约 60 秒后重试', 429, 60)
  }
}
