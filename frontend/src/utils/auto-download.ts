import { MediaDownloadError, responseDownloadError } from './download-error'
import { SINGLE_BUFFER_BYTES } from './download-buffer'

interface DownloadOptions {
  signal: AbortSignal
  totalTimeoutMs?: number
  responseTimeoutMs?: number
  readTimeoutMs?: number
  onProgress: (received: number, total?: number) => void
}

/** 受限读取媒体内容，支持取消、超时和大小限制。 */
export async function fetchMediaBlob(
  url: string,
  {
    signal,
    onProgress,
    totalTimeoutMs = 120000,
    responseTimeoutMs = 8000,
    readTimeoutMs = 15000,
  }: DownloadOptions,
  kind: 'video' | 'image' | 'audio' = 'video',
  maxBytes = SINGLE_BUFFER_BYTES,
): Promise<Blob> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdleTimer = (milliseconds: number) => {
    clearTimeout(idleTimer)
    idleTimer =
      milliseconds > 0
        ? setTimeout(
            () => controller.abort(new MediaDownloadError('TIMEOUT', '下载响应超时，请重试')),
            milliseconds,
          )
        : undefined
  }
  const totalTimer =
    totalTimeoutMs > 0
      ? setTimeout(
          () => controller.abort(new MediaDownloadError('TIMEOUT', '下载超时，请重试')),
          totalTimeoutMs,
        )
      : undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    resetIdleTimer(responseTimeoutMs)
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok) throw responseDownloadError(response.status)
    if (!response.body) throw new MediaDownloadError('INVALID_MEDIA', '媒体内容为空')
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
    if (
      contentType &&
      !contentType.startsWith(kind + '/') &&
      contentType !== 'application/octet-stream'
    ) {
      throw new MediaDownloadError('INVALID_MEDIA', '链接没有返回预期的媒体文件，请重新解析')
    }
    const length = Number(response.headers.get('Content-Length'))
    const total = Number.isFinite(length) && length > 0 ? length : undefined
    if (total && total > maxBytes)
      throw new MediaDownloadError('TOO_LARGE', '文件超过当前打包上限，请逐项下载')
    reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let received = 0
    while (true) {
      resetIdleTimer(readTimeoutMs)
      const { value, done } = await reader.read()
      controller.signal.throwIfAborted()
      if (done) break
      received += value.byteLength
      if (received > maxBytes)
        throw new MediaDownloadError('TOO_LARGE', '文件超过当前打包上限，请逐项下载')
      chunks.push(new Uint8Array(value).buffer)
      onProgress(received, total)
    }
    if (!received) throw new MediaDownloadError('INVALID_MEDIA', '媒体内容为空，请重新解析')
    signal.throwIfAborted()
    return new Blob(chunks, { type: contentType || 'application/octet-stream' })
  } catch (error) {
    signal.throwIfAborted()
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof MediaDownloadError) throw error
    throw new MediaDownloadError('NETWORK', '下载连接中断，请检查网络后重试')
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    signal.removeEventListener('abort', cancel)
    controller.abort()
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        /* 请求已中止。 */
      }
      reader.releaseLock()
    }
  }
}

export async function downloadDirectVideo(
  url: string,
  filename: string,
  options: DownloadOptions,
): Promise<void> {
  const blob = await fetchMediaBlob(url, options)
  options.signal.throwIfAborted()
  saveBlob(blob, filename)
}

export function saveBlob(
  blob: Blob,
  filename: string,
  { objectUrl, retain = false }: { objectUrl?: string; retain?: boolean } = {},
): string {
  const blobUrl = objectUrl ?? URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = filename
  let handedOff = false
  try {
    document.body.appendChild(anchor)
    anchor.click()
    handedOff = true
  } finally {
    anchor.remove()
    if (!handedOff && !objectUrl) URL.revokeObjectURL(blobUrl)
    // 页面任务由 prepared-download 管理同一个 URL；独立调用也不长期积累引用。
    if (handedOff && !retain) setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)
  }
  return blobUrl
}
