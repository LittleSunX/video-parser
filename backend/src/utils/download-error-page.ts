import type { Diagnostics } from './diagnostics'

/** 原生下载无法由 fetch 观察，错误文档在下载框架中向发起页面回报。 */
export async function downloadErrorPage(
  response: Response,
  token: string,
  trace: Diagnostics,
): Promise<Response> {
  const payload = (await response.json()) as { error: { code: string; message: string } }
  const message = {
    type: 'video-parser-download-error',
    token,
    code: payload.error.code,
    message: payload.error.message,
    requestId: trace.requestId,
    retryAfter: response.headers.get('Retry-After'),
  }
  const nonce = crypto.randomUUID()
  const encoded = JSON.stringify(message).replace(/</g, '\\u003c')
  const escaped = payload.error.message.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
  const headers = new Headers(response.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'`)
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>下载失败</title><body><p>${escaped}</p><p>请求编号：${trace.requestId}</p><script nonce="${nonce}">parent.postMessage(${encoded}, '*')</script></body></html>`,
    { status: response.status, headers },
  )
}
