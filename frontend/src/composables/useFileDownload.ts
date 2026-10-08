import { onScopeDispose, reactive } from 'vue'
import { fetchMediaBlob, saveBlob } from '../utils/auto-download'
import { buildDownloadUrl, triggerDownload } from '../utils/download'
import { MediaDownloadError } from '../utils/download-error'
import { imageFilename } from '../../../shared/media'

interface FileDownloadOptions {
  label: string
  kind: 'audio' | 'image'
  getTarget: () => { url: string; filename: string } | undefined
  showNotice: (message: string, duration?: number) => void
}

type DownloadState = 'receiving' | 'handed-off' | 'fallback' | 'cancelled' | 'failed'

/** 音乐与封面使用原有代理单次流式请求，读取数据时同步更新进度。 */
export function useFileDownload({ label, kind, getTarget, showNotice }: FileDownloadOptions) {
  let activeController: AbortController | undefined
  let nativeDispose: (() => void) | undefined
  let nativeRequestNumber = 0
  const download = reactive({
    downloading: false,
    status: '',
    state: 'receiving' as DownloadState,
    progress: undefined as number | undefined,
    needsReparse: false,
    start,
    cancel,
    reset,
    startBrowserDownload,
  })

  function stop() {
    activeController?.abort()
    activeController = undefined
    download.downloading = false
    nativeRequestNumber++
    nativeDispose?.()
    nativeDispose = undefined
  }

  function reset() {
    stop()
    download.status = ''
    download.state = 'receiving'
    download.progress = undefined
    download.needsReparse = false
  }

  function cancel() {
    stop()
    download.state = 'cancelled'
    download.status = '已取消' + label + '下载'
    download.progress = undefined
    download.needsReparse = false
  }

  async function start() {
    const target = getTarget()
    if (!target || download.downloading) return
    reset()
    const controller = new AbortController()
    activeController = controller
    download.downloading = true
    download.status = '正在连接' + label + '下载…'
    try {
      const blob = await fetchMediaBlob(
        buildDownloadUrl(target.url, target.filename),
        {
          signal: controller.signal,
          // 沿用代理端的响应与停滞超时，客户端不比原生下载更早中断慢连接。
          totalTimeoutMs: 0,
          responseTimeoutMs: 0,
          readTimeoutMs: 0,
          onProgress(received, total) {
            if (activeController !== controller) return
            download.progress = total
              ? Math.min(100, Math.round((received / total) * 100))
              : undefined
            download.status = total
              ? '正在下载 ' + download.progress + '%'
              : '已接收 ' + (received / 1024 / 1024).toFixed(1) + ' MB'
          },
        },
        kind,
      )
      if (activeController !== controller) return
      saveBlob(blob, kind === 'image' ? imageFilename(target.filename, blob.type) : target.filename)
      download.state = 'handed-off'
      download.status = '已请求浏览器保存，请查看下载列表；若未保存，可使用浏览器下载。'
      showNotice(label + '已交给浏览器保存，请查看下载列表', 6000)
    } catch (error) {
      if (controller.signal.aborted || activeController !== controller) return
      download.state = 'failed'
      download.needsReparse =
        error instanceof MediaDownloadError && ['EXPIRED', 'INVALID_MEDIA'].includes(error.code)
      download.status =
        error instanceof MediaDownloadError && error.code === 'TOO_LARGE'
          ? '文件较大，请使用浏览器下载。'
          : error instanceof Error
            ? error.message
            : label + '下载失败，请重试。'
      showNotice(download.status, 6000)
    } finally {
      if (activeController === controller) {
        activeController = undefined
        download.downloading = false
      }
    }
  }

  function startBrowserDownload() {
    const target = getTarget()
    if (!target || download.downloading) return
    reset()
    const requestNumber = ++nativeRequestNumber
    download.state = 'fallback'
    download.status = '已发起' + label + '下载，请查看浏览器下载列表。'
    try {
      nativeDispose = triggerDownload(target.url, target.filename, (error) => {
        if (requestNumber !== nativeRequestNumber) return
        nativeDispose = undefined
        download.state = 'failed'
        download.status = error.message
        download.needsReparse = ['MEDIA_UNAVAILABLE', 'INVALID_URL', 'DOWNLOAD_FAILED'].includes(
          error.code,
        )
        showNotice(error.message, 6000)
      })
      showNotice(download.status, 6000)
    } catch {
      download.state = 'failed'
      download.status = '未能发起' + label + '下载，请重试。'
      showNotice(download.status)
    }
  }

  window.addEventListener?.('pagehide', reset)
  onScopeDispose(() => {
    window.removeEventListener?.('pagehide', reset)
    reset()
  })
  return download
}

export type FileDownload = ReturnType<typeof useFileDownload>
