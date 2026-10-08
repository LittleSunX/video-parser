import type { VideoInfo } from '../types/video'

export interface NativeDownloadError {
  code: string
  message: string
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export function buildVideoFilename(video: VideoInfo): string {
  return buildFilename(video, 'mp4')
}

export function buildCoverFilename(video: VideoInfo): string {
  return buildFilename(video, 'jpg', '封面')
}

export function buildImageFilename(video: VideoInfo, index: number): string {
  return buildFilename(video, 'jpg', String(index + 1).padStart(2, '0'))
}

export function buildLivePhotoFilename(video: VideoInfo, index: number): string {
  return buildFilename(video, 'mp4', '实况_' + String(index + 1).padStart(2, '0'))
}

export function buildMusicFilename(video: VideoInfo): string {
  return buildFilename(video, 'mp3', '背景音乐')
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'

  document.body.appendChild(textarea)
  textarea.select()

  const copied = document.execCommand('copy')
  textarea.remove()

  if (!copied) {
    throw new Error('复制失败，请手动复制')
  }
}

// 跨域媒体由浏览器直接打开，避免视频流量经过 Worker。
// download 属性无法保证跨域下载或文件名，因此保留代理下载入口。
export function openDirectDownload(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export function buildDownloadUrl(url: string, filename: string): string {
  return (
    apiBaseUrl +
    '/api/download?url=' +
    encodeURIComponent(url) +
    '&filename=' +
    encodeURIComponent(filename)
  )
}

export function triggerDownload(
  url: string,
  filename: string,
  onError: (error: NativeDownloadError) => void = () => {},
): () => void {
  const token = crypto.randomUUID()
  const downloadUrl = new URL(buildDownloadUrl(url, filename), window.location.href)
  downloadUrl.searchParams.set('errorToken', token)
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.title = '媒体下载'
  frame.referrerPolicy = 'no-referrer'
  const cleanup = () => {
    window.removeEventListener('message', receiveError)
    frame.remove()
  }
  const receiveError = (event: MessageEvent) => {
    if (event.origin !== downloadUrl.origin || event.source !== frame.contentWindow) return
    const data = event.data
    if (
      !data ||
      data.type !== 'video-parser-download-error' ||
      data.token !== token ||
      typeof data.message !== 'string' ||
      data.message.length > 300 ||
      typeof data.code !== 'string' ||
      !/^[A-Z_]{1,64}$/.test(data.code)
    )
      return
    let message = data.message
    const seconds = Number(data.retryAfter)
    if (data.code === 'RATE_LIMITED' && Number.isFinite(seconds) && seconds > 0)
      message = '请求过于频繁，请等待约 ' + Math.ceil(Math.min(seconds, 3600)) + ' 秒后重试'
    if (typeof data.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(data.requestId))
      message += '（请求编号：' + data.requestId + '）'
    cleanup()
    onError({ code: data.code, message })
  }
  window.addEventListener('message', receiveError)
  try {
    frame.src = downloadUrl.toString()
    document.body.appendChild(frame)
  } catch (error) {
    cleanup()
    throw error
  }
  // 成功下载交由浏览器管理；框架保留至结果清理，避免中途拆除打断传输。
  return cleanup
}

function buildFilename(video: VideoInfo, extension: string, suffix?: string): string {
  const parts = [
    '抖音',
    sanitizeFilePart(video.author ?? ''),
    sanitizeFilePart(video.title),
    video.videoId,
    suffix,
  ].filter(Boolean)

  const basename =
    parts
      .join('_')
      .slice(0, 150)
      .replace(/[. ]+$/g, '') || video.videoId

  return basename + '.' + extension
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 48)
}
