export type DownloadErrorCode =
  'NETWORK' | 'TIMEOUT' | 'EXPIRED' | 'TOO_LARGE' | 'INVALID_MEDIA' | 'BUSY'

export class MediaDownloadError extends Error {
  constructor(
    public readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MediaDownloadError'
  }
}

export function responseDownloadError(status: number): MediaDownloadError {
  if ([401, 403, 404, 410, 422].includes(status))
    return new MediaDownloadError('EXPIRED', '资源链接已失效或不可访问，请重新解析')
  if ([408, 504].includes(status)) return new MediaDownloadError('TIMEOUT', '下载响应超时，请重试')
  if ([429, 503].includes(status)) return new MediaDownloadError('BUSY', '下载服务繁忙，请稍后重试')
  return new MediaDownloadError('NETWORK', '下载连接失败，请检查网络后重试')
}
