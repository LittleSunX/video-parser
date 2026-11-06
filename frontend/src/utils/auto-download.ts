import { MediaDownloadError, responseDownloadError } from './download-error'
import { SINGLE_BUFFER_BYTES, VIDEO_BUFFER_BYTES } from './download-buffer'
import { MAX_VIDEO_URL_ALTERNATIVES } from '../../../shared/video'

interface DownloadOptions {
  signal: AbortSignal
  /** 同一文件的上游 HTTPS 镜像；最多尝试两个，不改写签名或降低画质。 */
  alternativeUrls?: string[]
  /** 完整接收后记住所用地址，供打开直链和复制地址复用。 */
  onSourceReady?: (url: string) => void
  totalTimeoutMs?: number
  responseTimeoutMs?: number
  readTimeoutMs?: number
  /** 仅批量任务使用：响应头到达后预约读取预算，不另发探测请求。 */
  beforeRead?: (total?: number) => number
  onProgress: (received: number, total?: number) => void
}

export function mediaDownloadUrls(url: string, alternativeUrls: string[] = []): string[] {
  return [
    ...new Set([url, ...alternativeUrls.filter((value) => /^https:\/\//i.test(value))]),
  ].slice(0, MAX_VIDEO_URL_ALTERNATIVES + 1)
}

/** 首地址失败时尝试同一文件的其他直连地址，每次都独立读取完整文件。 */
export async function fetchMediaBlob(
  url: string,
  options: DownloadOptions,
  kind: 'video' | 'image' | 'audio' = 'video',
  maxBytes = kind === 'video' ? VIDEO_BUFFER_BYTES : SINGLE_BUFFER_BYTES,
): Promise<Blob> {
  const urls = mediaDownloadUrls(url, options.alternativeUrls)
  let lastError: unknown
  for (const candidate of urls) {
    options.signal.throwIfAborted()
    let blob: Blob
    try {
      blob = await fetchSingleMediaBlob(candidate, options, kind, maxBytes)
    } catch (error) {
      options.signal.throwIfAborted()
      // 这些失败与同一文件的节点无关，避免重复传输或增加上游请求。
      if (!(error instanceof MediaDownloadError) || ['TOO_LARGE', 'BUSY'].includes(error.code))
        throw error
      lastError = error
      continue
    }
    options.signal.throwIfAborted()
    options.onSourceReady?.(candidate)
    return blob
  }
  throw lastError
}

/** 受限读取单个地址的媒体内容，支持取消、超时和大小限制。 */
async function fetchSingleMediaBlob(
  url: string,
  {
    signal,
    onProgress,
    totalTimeoutMs = 120000,
    responseTimeoutMs = 8000,
    readTimeoutMs = 15000,
    beforeRead,
  }: DownloadOptions,
  kind: 'video' | 'image' | 'audio' = 'video',
  maxBytes = kind === 'video' ? VIDEO_BUFFER_BYTES : SINGLE_BUFFER_BYTES,
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
  let response: Response | undefined
  try {
    resetIdleTimer(responseTimeoutMs)
    response = await waitForAbort<Response>(
      fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }).then((result) => {
        // 某些浏览器的连接结束晚于中止事件，迟到的响应不能继续占用媒体流。
        if (controller.signal.aborted) {
          cancelBody(result.body)
          controller.signal.throwIfAborted()
        }
        return result
      }),
      controller.signal,
    )
    controller.signal.throwIfAborted()
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
    if (beforeRead) maxBytes = Math.min(maxBytes, beforeRead(total))
    if (total && total > maxBytes)
      throw new MediaDownloadError('TOO_LARGE', '文件超过当前打包上限，请逐项下载')
    reader = response.body.getReader()
    const chunks: BlobPart[] = []
    let received = 0
    while (true) {
      resetIdleTimer(readTimeoutMs)
      const { value, done } = await waitForAbort(reader.read(), controller.signal)
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
    if (reader) releaseReader(reader)
    else cancelBody(response?.body)
  }
}

/** 不依赖底层 fetch/read 响应中止，避免连接或流清理挂起时越过下载期限。 */
function waitForAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    // 始终接收迟到的成功或失败，避免中止后的 Promise 拒绝无人处理。
    pending.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

function cancelBody(body: ReadableStream<Uint8Array> | null | undefined) {
  try {
    void body?.cancel().catch(() => {})
  } catch {
    /* 媒体流已释放。 */
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const release = () => {
    try {
      reader.releaseLock()
    } catch {
      /* 底层读取尚未响应中止，取消完成后再次释放。 */
    }
  }
  try {
    // cancel 会结束待处理的读取；其底层清理可能不结束，不能阻塞失败或代理回退。
    void reader.cancel().then(release, release)
  } catch {
    /* 媒体流已中止。 */
  }
  release()
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
