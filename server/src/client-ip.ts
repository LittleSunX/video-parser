import { isIP } from 'node:net'
import type { ServerConfig } from './config'

export function normalizeIp(value: string | undefined): string {
  if (!value || value.includes('%') || !isIP(value)) throw new Error('Invalid client address')
  if (isIP(value) === 4) return value
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical)
  if (!mapped) return canonical
  const high = parseInt(mapped[1], 16)
  const low = parseInt(mapped[2], 16)
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.')
}

export function clientIdentity(
  peer: string | undefined,
  headers: Headers,
  trustProxy: ServerConfig['trustProxy'],
): string {
  const address = normalizeIp(peer)
  const loopback = address === '::1' || address.startsWith('127.')
  // Nginx must OVERWRITE X-Real-IP with $remote_addr, never append it.
  // X-Forwarded-For and Forwarded are deliberately never consulted.
  if (trustProxy === 'loopback' && loopback && headers.has('x-real-ip')) {
    return normalizeIp(headers.get('x-real-ip') ?? undefined)
  }
  return address
}
