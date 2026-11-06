export type DownloadErrorCode =
  'NETWORK' | 'TIMEOUT' | 'EXPIRED' | 'TOO_LARGE' | 'INVALID_MEDIA' | 'BUSY'

export class MediaDownloadError extends Error {
  constructor(
    public readonly code: DownloadErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'MediaDownloadError'
  }
}

export function responseDownloadError(status: number): MediaDownloadError {
  if ([401, 403, 404, 410, 422].includes(status))
    return new MediaDownloadError('EXPIRED', '资源链接已失效或不可访问，请重新解析', status)
  if ([408, 504].includes(status))
    return new MediaDownloadError('TIMEOUT', '下载响应超时，请重试', status)
  if ([429, 503].includes(status))
    return new MediaDownloadError('BUSY', '下载服务繁忙，请稍后重试', status)
  return new MediaDownloadError('NETWORK', '下载连接失败，请检查网络后重试', status)
}

export function directDownloadFallbackMessage(error: unknown): string {
  let reason = '直连未能完成'
  if (error instanceof MediaDownloadError) {
    const reasons: Record<DownloadErrorCode, string> = {
      NETWORK: '直连受网络或浏览器跨域限制',
      TIMEOUT: '直连响应或读取超时',
      EXPIRED: '直连资源已失效或不可访问',
      TOO_LARGE: '文件超过页面缓冲上限',
      INVALID_MEDIA: '直连未返回有效媒体',
      BUSY: '媒体服务器繁忙',
    }
    reason = reasons[error.code] ?? reason
    if (error.status === 401 || error.status === 403)
      reason = '媒体服务器拒绝直连（HTTP ' + error.status + '）'
  }
  return reason + '，已切换到备用下载'
}
