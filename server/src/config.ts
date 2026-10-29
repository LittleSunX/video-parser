import { isIP } from 'node:net'

export interface ServerConfig {
  host: string
  port: number
  trustProxy: 'none' | 'loopback'
  maxConcurrentParses: number
  maxConcurrentDownloads: number
  maxDownloadsPerIp: number
  shutdownTimeoutMs: number
}

export function readConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const integer = (name: string, fallback: number, max = 1_000_000) => {
    const raw = env[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max) {
      throw new Error(`Invalid ${name}`)
    }
    return value
  }
  const host = env.HOST ?? '127.0.0.1'
  if (!isIP(host) || host.includes('%'))
    throw new Error('Invalid HOST: use an IPv4 or IPv6 literal')
  const trustProxy = env.TRUST_PROXY ?? 'none'
  if (trustProxy !== 'none' && trustProxy !== 'loopback') throw new Error('Invalid TRUST_PROXY')
  return {
    host,
    port: integer('PORT', 8787, 65535),
    trustProxy,
    maxConcurrentParses: integer('MAX_CONCURRENT_PARSES', 8),
    maxConcurrentDownloads: integer('MAX_CONCURRENT_DOWNLOADS', 16),
    maxDownloadsPerIp: integer('MAX_DOWNLOADS_PER_IP', 4),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 15_000, 2_147_483_647),
  }
}
