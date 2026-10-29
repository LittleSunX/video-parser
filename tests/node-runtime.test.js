import { expect, test, vi } from 'vitest'

test('limiter bounds keys without evicting live budgets and proactively expires idle entries', async () => {
  const { createRateLimiter } = await limiterModule()
  vi.useFakeTimers()
  let now = 0
  const limiter = createRateLimiter({ now: () => now, maxKeys: 2, cleanupIntervalMs: 1000 })
  try {
    expect(await limiter.limit('parse', 'a')).toEqual({ status: 'allowed' })
    expect(await limiter.limit('download', 'a')).toEqual({ status: 'allowed' })
    expect(await limiter.limit('parse', 'b')).toEqual({ status: 'unavailable' })
    expect(limiter.size).toBe(2)
    now = 60_000
    await vi.advanceTimersByTimeAsync(1000)
    expect(limiter.size).toBe(0)
    expect(await limiter.limit('parse', 'b')).toEqual({ status: 'allowed' })
    limiter.close()
    expect(await limiter.limit('parse', 'b')).toEqual({ status: 'unavailable' })
  } finally {
    limiter.close()
    vi.useRealTimers()
  }
})

async function limiterModule() {
  return import('../server/src/rate-limit.ts')
}

test('clock faults and invalid limiter settings fail closed', async () => {
  const { createRateLimiter } = await limiterModule()
  for (const maxKeys of [0, -1, 1.5, NaN]) expect(() => createRateLimiter({ maxKeys })).toThrow()
  let time = 0
  const limiter = createRateLimiter({
    now: () => {
      if (time === -1) throw Error('secret')
      return time
    },
  })
  try {
    time = NaN
    expect(await limiter.limit('parse', 'a')).toEqual({ status: 'unavailable' })
    time = -1
    expect(await limiter.limit('parse', 'a')).toEqual({ status: 'unavailable' })
    time = 10
    expect(await limiter.limit('parse', 'a')).toEqual({ status: 'allowed' })
    time = 5
    expect(await limiter.limit('parse', 'a')).toEqual({ status: 'unavailable' })
    expect(await limiter.limit('unknown', 'a')).toEqual({ status: 'unavailable' })
  } finally {
    limiter.close()
  }
})

test('server configuration has safe defaults and rejects ambiguous environment values', async () => {
  const { readConfig } = await import('../server/src/config.ts')
  expect(readConfig({})).toEqual({
    host: '127.0.0.1',
    port: 8787,
    trustProxy: 'none',
    maxConcurrentParses: 8,
    maxConcurrentDownloads: 16,
    maxDownloadsPerIp: 4,
    shutdownTimeoutMs: 15000,
  })
  expect(
    readConfig({
      HOST: '::1',
      PORT: '3000',
      TRUST_PROXY: 'loopback',
      MAX_CONCURRENT_PARSES: '2',
      MAX_CONCURRENT_DOWNLOADS: '5',
      MAX_DOWNLOADS_PER_IP: '3',
      SHUTDOWN_TIMEOUT_MS: '100',
    }),
  ).toEqual({
    host: '::1',
    port: 3000,
    trustProxy: 'loopback',
    maxConcurrentParses: 2,
    maxConcurrentDownloads: 5,
    maxDownloadsPerIp: 3,
    shutdownTimeoutMs: 100,
  })
  for (const env of [
    { PORT: '0' },
    { PORT: '65536' },
    { PORT: '8787x' },
    { PORT: '' },
    { PORT: ' 8787' },
    { HOST: '' },
    { HOST: 'localhost' },
    { HOST: '127.0.0.1:8787' },
    { HOST: '[::1]' },
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '' },
    { MAX_CONCURRENT_PARSES: '0' },
    { MAX_CONCURRENT_DOWNLOADS: '1.5' },
    { MAX_DOWNLOADS_PER_IP: '-1' },
    { SHUTDOWN_TIMEOUT_MS: '2147483648' },
  ])
    expect(() => readConfig(env)).toThrow()
})

test('client identity trusts only loopback peers with explicit opt-in and normalizes IPv6', async () => {
  const { clientIdentity, normalizeIp } = await import('../server/src/client-ip.ts')
  expect(normalizeIp('0:0:0:0:0:0:0:1')).toBe('::1')
  expect(normalizeIp('::FFFF:192.0.2.8')).toBe('192.0.2.8')
  expect(normalizeIp('::ffff:c000:208')).toBe('192.0.2.8')
  expect(normalizeIp('2001:0DB8:0000::1')).toBe('2001:db8::1')
  for (const bad of [
    '',
    ' 127.0.0.1',
    '127.1',
    '0127.0.0.1',
    '[::1]',
    'fe80::1%eth0',
    '1.2.3.4:12',
    '192.0.2.1, 192.0.2.2',
  ])
    expect(() => normalizeIp(bad)).toThrow()
  const spoofed = new Headers({ 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '198.51.100.1' })
  expect(clientIdentity('127.0.0.1', spoofed, 'none')).toBe('127.0.0.1')
  expect(clientIdentity('203.0.113.1', spoofed, 'loopback')).toBe('203.0.113.1')
  expect(clientIdentity('::ffff:127.0.0.1', spoofed, 'loopback')).toBe('192.0.2.1')
  expect(clientIdentity('::1', new Headers(), 'loopback')).toBe('::1')
  for (const bad of ['', 'bad', '192.0.2.1, 192.0.2.2'])
    expect(() =>
      clientIdentity('127.0.0.1', new Headers({ 'x-real-ip': bad }), 'loopback'),
    ).toThrow()
  expect(() => clientIdentity(undefined, spoofed, 'none')).toThrow()
})

test('fixed windows share per-client operation budgets and expire at 60 seconds', async () => {
  const { createRateLimiter } = await limiterModule()
  let now = 0
  const limiter = createRateLimiter({ now: () => now })
  try {
    for (let i = 0; i < 10; i++)
      expect(await limiter.limit('parse', '192.0.2.1')).toEqual({ status: 'allowed' })
    expect(await limiter.limit('parse', '192.0.2.1')).toEqual({ status: 'limited', retryAfter: 60 })
    now = 1_500
    expect(await limiter.limit('parse', '192.0.2.1')).toEqual({ status: 'limited', retryAfter: 59 })
    expect(await limiter.limit('parse', '192.0.2.2')).toEqual({ status: 'allowed' })
    for (let i = 0; i < 120; i++)
      expect(await limiter.limit('download', '192.0.2.1')).toEqual({ status: 'allowed' })
    expect(await limiter.limit('download', '192.0.2.1')).toEqual({
      status: 'limited',
      retryAfter: 60,
    })
    now = 60_000
    expect(await limiter.limit('parse', '192.0.2.1')).toEqual({ status: 'allowed' })
  } finally {
    limiter.close()
  }
})
