type FullMediaRange = { valid: true; length?: number } | { valid: false }

/** 全量下载的 206 必须可证明覆盖完整文件；主动 Range 续传不使用此规则。 */
export function validateFullMediaRange(
  response: Pick<Response, 'status' | 'headers'>,
): FullMediaRange {
  if (response.status !== 206) return { valid: true }
  // 跨域响应未暴露 Content-Range 时也无法证明完整。
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(
    response.headers.get('Content-Range')?.trim() ?? '',
  )
  if (!range) return { valid: false }
  const [start, end, total] = range.slice(1).map(Number)
  if (
    ![start, end, total].every(Number.isSafeInteger) ||
    start !== 0 ||
    total <= 0 ||
    end !== total - 1
  )
    return { valid: false }

  const encoding = response.headers.get('Content-Encoding')?.trim().toLowerCase()
  const length = response.headers.get('Content-Length')
  // 范围描述编码后的字节；不能用浏览器解码后的内容冒充该范围。
  if (
    (encoding && encoding !== 'identity') ||
    (length !== null && (!/^\d+$/.test(length.trim()) || Number(length) !== total))
  )
    return { valid: false }
  return { valid: true, length: total }
}
