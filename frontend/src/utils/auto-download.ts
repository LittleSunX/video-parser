const MAX_BUFFER_BYTES = 64 * 1024 * 1024

interface DownloadOptions {
  signal: AbortSignal
  onProgress: (received: number, total?: number) => void
}

/** 直接从媒体 CDN 读取；成功后用同源 Blob URL 请求浏览器保存。 */
export async function downloadDirectVideo(
  url: string,
  filename: string,
  { signal, onProgress }: DownloadOptions,
): Promise<void> {
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
    if (contentType && !contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
      throw new Error('直链没有返回视频文件')
    }
    const length = Number(response.headers.get('Content-Length'))
    const total = Number.isFinite(length) && length > 0 ? length : undefined
    if (total && total > MAX_BUFFER_BYTES) throw new Error('大文件使用浏览器下载')
    reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let received = 0
    while (true) {
      resetIdleTimer(15000)
      const { value, done } = await reader.read()
      controller.signal.throwIfAborted()
      if (done) break
      received += value.byteLength
      if (received > MAX_BUFFER_BYTES) throw new Error('大文件使用浏览器下载')
      chunks.push(new Uint8Array(value).buffer)
      onProgress(received, total)
    }
    if (!received) throw new Error('视频内容为空')
    signal.throwIfAborted()
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: contentType || 'video/mp4' }))
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
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    signal.removeEventListener('abort', cancel)
    controller.abort()
    if (reader) {
      try { await reader.cancel() } catch { /* 请求已中止。 */ }
      reader.releaseLock()
    }
  }
}
