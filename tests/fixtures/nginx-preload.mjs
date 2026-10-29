// Test-only --import preload. Never imported by the production entry point.
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { URL } from 'node:url'

const nativeFetch = globalThis.fetch
const approvedHosts = new Set([
  'www.douyin.com',
  'v.douyin.com',
  'm.douyin.com',
  'www.iesdouyin.com',
  'api5-normal-c-hl.amemv.com',
  'aweme.snssdk.com',
  'v.douyinvod.com',
  'p.douyinpic.com',
])

export function createOfflineFetch(origin, onBlocked = () => {}) {
  const local = new URL(origin)
  if (
    local.protocol !== 'http:' ||
    local.hostname !== '127.0.0.1' ||
    !local.port ||
    local.username ||
    local.password ||
    local.pathname !== '/' ||
    local.search ||
    local.hash
  ) {
    throw new Error('Invalid offline fixture origin')
  }
  return async (input, init) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : input)
    if (
      url.protocol !== 'https:' ||
      !approvedHosts.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    ) {
      onBlocked()
      throw new Error('Offline fixture refuses unconfigured outbound destination')
    }
    const request = new globalThis.Request(input, init)
    // Even an accidental fixture redirect must never escape to the public network.
    return nativeFetch(new globalThis.Request(local.origin + url.pathname + url.search, request), {
      redirect: 'manual',
    })
  }
}

if (process.env.NGINX_FIXTURE_ORIGIN) {
  globalThis.fetch = createOfflineFetch(process.env.NGINX_FIXTURE_ORIGIN, () => {
    // No raw URL/signature is recorded, even on a fixture-guard failure.
    appendFileSync(process.env.NGINX_FIXTURE_BLOCKED_LOG, 'blocked\n')
  })
}
