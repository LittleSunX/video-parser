import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { handleRequest } from '../backend/src/http/handle-request'

const version = {
  runtime: 'node',
  id: 'cf254f70-cb48-4fae-b7a5-901b92ab4c1a',
  tag: 'a'.repeat(40),
  timestamp: '2026-10-20T00:00:00.000Z',
}
const context = { clientId: '192.0.2.1' }
const runtime = () => ({ version, rateLimit: vi.fn(async () => ({ status: 'allowed' })) })
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

test.each(['node', 'cloudflare-worker'])(
  'shared health uses injected %s metadata without bindings',
  async (kind) => {
    const adapter = runtime()
    adapter.version = { ...version, runtime: kind }
    const response = await handleRequest(
      new Request('https://api.example/api/health'),
      adapter,
      context,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: {
        service: 'video-parser-api',
        status: 'ok',
        runtime: kind,
        version: version.id,
        versionTag: version.tag,
        versionCreatedAt: version.timestamp,
      },
    })
    expect(response.headers.get('X-Worker-Version')).toBe(version.id)
    expect(response.headers.get('X-API-Version')).toBe(version.id)
    expect(response.headers.get('X-API-Runtime')).toBe(kind)
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-API-Version')
    expect(adapter.rateLimit).not.toHaveBeenCalled()
  },
)

test.each([
  [{ status: 'limited', retryAfter: 7 }, 429],
  [{ status: 'unavailable' }, 503],
  [{ status: 'limited', retryAfter: -1 }, 503],
  [undefined, 503],
])(
  'rate limit decision %j is fail-closed with trusted adapter identity',
  async (result, status) => {
    const adapter = runtime()
    adapter.rateLimit.mockResolvedValue(result)
    const response = await handleRequest(
      new Request('https://api.example/api/parse', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '198.51.100.99', 'CF-Connecting-IP': '198.51.100.88' },
      }),
      adapter,
      context,
    )
    expect(adapter.rateLimit).toHaveBeenCalledWith('parse', context.clientId)
    expect(response.status).toBe(status)
    expect(response.headers.get('Retry-After')).toBe(status === 429 ? '7' : null)
  },
)
