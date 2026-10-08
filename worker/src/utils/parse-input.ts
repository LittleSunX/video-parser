import { AppError } from '../errors/app-error'

const MAX_BODY_BYTES = 32 * 1024

export async function readParseInput(request: Request): Promise<string> {
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded') {
    throw new AppError('INVALID_CONTENT_TYPE', '请使用 JSON 或表单格式提交分享链接', 415)
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    throw new AppError('INPUT_TOO_LARGE', '输入内容过长，请只粘贴作品分享链接', 413)
  }
  if (!request.body) throw new AppError('INVALID_INPUT', '请输入作品分享链接')
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new AppError('INPUT_TOO_LARGE', '输入内容过长，请只粘贴作品分享链接', 413)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  let input: unknown
  if (contentType === 'application/x-www-form-urlencoded') {
    const values = new URLSearchParams(text).getAll('url')
    if (values.length === 1) input = values[0]
  } else {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AppError('INVALID_INPUT', '请求内容格式不正确，请重新提交分享链接')
    }
    if (body && typeof body === 'object' && !Array.isArray(body) && 'url' in body) input = body.url
  }
  if (typeof input !== 'string' || !input.trim()) {
    throw new AppError('INVALID_INPUT', '请输入有效的作品分享链接或分享文案')
  }
  if (input.length > 5000) {
    throw new AppError('INPUT_TOO_LARGE', '输入内容过长，请只粘贴作品分享链接', 413)
  }
  return input.trim()
}
