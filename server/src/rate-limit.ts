import type { ApiOperation, RateLimitResult } from '@video-parser/backend/runtime'

export function createRateLimiter(
  options: {
    now?: () => number
    maxKeys?: number
    cleanupIntervalMs?: number
  } = {},
) {
  const now = options.now ?? Date.now
  const maxKeys = options.maxKeys ?? 10_000
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 30_000
  if (
    !Number.isSafeInteger(maxKeys) ||
    maxKeys < 1 ||
    !Number.isSafeInteger(cleanupIntervalMs) ||
    cleanupIntervalMs < 1 ||
    cleanupIntervalMs > 2_147_483_647
  ) {
    throw new Error('Invalid rate limiter settings')
  }
  let lastTime = -Infinity
  const readTime = () => {
    const time = now()
    if (!Number.isFinite(time) || time < lastTime) throw new Error('Rate limiter clock unavailable')
    lastTime = time
    return time
  }
  const windows = new Map<string, { count: number; expires: number }>()
  let closed = false
  const cleanup = (time: number) => {
    for (const [key, window] of windows) if (time >= window.expires) windows.delete(key)
  }
  const timer = setInterval(() => {
    try {
      cleanup(readTime())
    } catch {
      /* Keep live budgets when the clock fails. */
    }
  }, cleanupIntervalMs)
  timer.unref()
  return {
    get size() {
      return windows.size
    },
    async limit(operation: ApiOperation, clientId: string): Promise<RateLimitResult> {
      if (closed || !['parse', 'download'].includes(operation) || !clientId || clientId.length > 64)
        return { status: 'unavailable' }
      let time: number
      try {
        time = readTime()
      } catch {
        return { status: 'unavailable' }
      }
      const key = `${operation}:${clientId}`
      let window = windows.get(key)
      if (!window || time >= window.expires) {
        if (!window && windows.size >= maxKeys) cleanup(time)
        if (!window && windows.size >= maxKeys) return { status: 'unavailable' }
        window = { count: 0, expires: time + 60_000 }
        windows.set(key, window)
      }
      if (window.count >= (operation === 'parse' ? 10 : 120)) {
        return { status: 'limited', retryAfter: Math.ceil((window.expires - time) / 1000) }
      }
      window.count++
      return { status: 'allowed' }
    },
    close() {
      closed = true
      clearInterval(timer)
      windows.clear()
    },
  }
}
