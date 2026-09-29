const MAX_BUFFER_BYTES = 64 * 1024 * 1024

interface DownloadOptions {
  signal: AbortSignal
  onProgress: (received: number, total?: number) => void
}

/** 受限读取媒体内容，支持取消、超时和大小限制。 */
export async function fetchMediaBlob(
  url: string,
  { signal, onProgress }: DownloadOptions,
  kind: 'video' | 'image' = 'video',
  maxBytes = MAX_BUFFER_BYTES,
): Promise<Blob> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdleTimer = (milliseconds: number) => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error('直链响应超时')), milliseconds)
  }
  const totalTimer = setTimeout(() => controller.abort(new Error('直链下载超时')), 120000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    resetIdleTimer(8000)
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error('直链暂不可用')
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
    if (
      contentType &&
      !contentType.startsWith(kind + '/') &&
      contentType !== 'application/octet-stream'
    ) {
      throw new Error('链接没有返回预期的媒体文件')
    }
    const length = Number(response.headers.get('Content-Length'))
    const total = Number.isFinite(length) && length > 0 ? length : undefined
    if (total && total > maxBytes) throw new Error('文件超出下载大小限制')
    reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let received = 0
    while (true) {
      resetIdleTimer(15000)
      const { value, done } = await reader.read()
      controller.signal.throwIfAborted()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) throw new Error('文件超出下载大小限制')
      chunks.push(new Uint8Array(value).buffer)
      onProgress(received, total)
    }
    if (!received) throw new Error('媒体内容为空')
    signal.throwIfAborted()
    return new Blob(chunks, { type: contentType || 'application/octet-stream' })
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

export function saveBlob(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = filename
  try {
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    // 给移动端下载管理器留出接管 Blob 的时间。
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
  }
}
