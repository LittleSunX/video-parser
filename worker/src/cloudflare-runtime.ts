import type { ApiRuntime, ApiVersion } from '@video-parser/backend/runtime'

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  CF_VERSION_METADATA?: Omit<ApiVersion, 'runtime'>
  PARSE_RATE_LIMITER: RateLimiter
  DOWNLOAD_RATE_LIMITER: RateLimiter
}

export function createCloudflareRuntime(env: Env): ApiRuntime {
  return {
    version: { id: 'unknown', ...env?.CF_VERSION_METADATA, runtime: 'cloudflare-worker' },
    async rateLimit(kind, clientId) {
      const limiter = kind === 'parse' ? env?.PARSE_RATE_LIMITER : env?.DOWNLOAD_RATE_LIMITER
      if (!limiter) {
        console.error('Missing rate limit binding:', kind)
        return { status: 'unavailable' }
      }
      try {
        const result = await limiter.limit({ key: 'video-parser:' + kind + ':' + clientId })
        if (result.success === true) return { status: 'allowed' }
        if (result.success === false) return { status: 'limited', retryAfter: 60 }
      } catch {
        console.error('Rate limiter failed:', kind)
      }
      return { status: 'unavailable' }
    },
  }
}
