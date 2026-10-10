import { onScopeDispose, reactive } from 'vue'
import { fetchMediaBlob } from '../utils/auto-download'
import { buildDownloadUrl, triggerDownload } from '../utils/download'
import { MediaDownloadError } from '../utils/download-error'
import { imageFilename } from '../../../shared/media'
import {
  createDownloadBufferBudget,
  PAGE_BUFFER_BUDGET_BYTES,
  type DownloadBufferBudget,
} from '../utils/download-buffer'
import { createPreparedDownload } from '../utils/prepared-download'

interface FileDownloadOptions {
  label: string
  kind: 'audio' | 'image'
  getTarget: () => { url: string; filename: string } | undefined
  showNotice: (message: string, duration?: number) => void
  bufferBudget?: DownloadBufferBudget
}

type DownloadState = 'receiving' | 'handed-off' | 'fallback' | 'cancelled' | 'failed'

/** 音乐优先直连，失败时回退一次代理；封面沿用代理，流式读取时更新进度。 */
export function useFileDownload({
  label,
  kind,
  getTarget,
  showNotice,
  bufferBudget = createDownloadBufferBudget(),
}: FileDownloadOptions) {
  let activeController: AbortController | undefined
  let nativeDispose: (() => void) | undefined
  let nativeRequestNumber = 0
  let releaseBuffer: (() => void) | undefined
  const prepared = createPreparedDownload(() => bufferBudget.retain(owner, 0))
  const owner = bufferBudget.register(() => {
    prepared.clear()
    bufferBudget.retain(owner, 0)
  })
  const download = reactive({
    downloading: false,
    status: '',
    state: 'receiving' as DownloadState,
    progress: undefined as number | undefined,
    needsReparse: false,
    canSaveAgain: prepared.canSave,
    bufferBusy: bufferBudget.busy,
    start,
    cancel,
    reset,
    startBrowserDownload,
    saveAgain,
  })

  function stop() {
    activeController?.abort()
    activeController = undefined
    download.downloading = false
    releaseBuffer?.()
    releaseBuffer = undefined
    nativeRequestNumber++
    nativeDispose?.()
    nativeDispose = undefined
  }

  function reset() {
    stop()
    prepared.clear()
    bufferBudget.retain(owner, 0)
    download.status = ''
    download.state = 'receiving'
    download.progress = undefined
    download.needsReparse = false
  }

  function cancel() {
    reset()
    download.state = 'cancelled'
    download.status = '已取消' + label + '下载'
    download.progress = undefined
    download.needsReparse = false
  }

  async function start() {
    const target = getTarget()
    if (!target || download.downloading) return
    const release = bufferBudget.acquire(owner, PAGE_BUFFER_BUDGET_BYTES)
    if (!release) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
    reset()
    releaseBuffer = release
    const controller = new AbortController()
    activeController = controller
    download.downloading = true
    download.status = '正在连接' + label + '下载…'
    try {
      const options = {
        signal: controller.signal,
        // 持续收到数据时不限制总时长，另行保护浏览器到下载服务的连接和停滞。
        totalTimeoutMs: 0,
        onProgress(received: number, total?: number) {
          if (activeController !== controller) return
          download.progress = total
            ? Math.min(100, Math.round((received / total) * 100))
            : undefined
          download.status = total
            ? '正在下载 ' + download.progress + '%'
            : '已接收 ' + (received / 1024 / 1024).toFixed(1) + ' MB'
        },
      }
      const fetchFromProxy = () =>
        fetchMediaBlob(
          buildDownloadUrl(target.url, target.filename),
          {
            ...options,
            // 给 Worker 的 15 秒响应、30 秒上游停滞保护留出网络传输余量。
            responseTimeoutMs: 30000,
            readTimeoutMs: 45000,
          },
          kind,
        )
      let blob: Blob
      if (kind === 'audio') {
        try {
          blob = await fetchMediaBlob(
            target.url,
            { ...options, responseTimeoutMs: 8000, readTimeoutMs: 15000 },
            kind,
          )
        } catch (error) {
          controller.signal.throwIfAborted()
          if (
            !(error instanceof MediaDownloadError) ||
            !['NETWORK', 'TIMEOUT', 'EXPIRED', 'INVALID_MEDIA'].includes(error.code)
          )
            throw error
          download.progress = undefined
          download.status = '正在重新连接' + label + '下载…'
          blob = await fetchFromProxy()
        }
      } else blob = await fetchFromProxy()
      if (activeController !== controller) return
      prepared.prepare(
        blob,
        kind === 'image' ? imageFilename(target.filename, blob.type) : target.filename,
      )
      bufferBudget.retain(owner, blob.size)
      prepared.save()
      download.state = 'handed-off'
      download.status = '已请求浏览器保存，请查看下载列表；未保存时可在 30 秒内再次保存。'
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
      release()
      if (activeController === controller) {
        releaseBuffer = undefined
        activeController = undefined
        download.downloading = false
      }
    }
  }

  function saveAgain() {
    if (!getTarget() || download.downloading || bufferBudget.busy.value) return
    try {
      if (!prepared.save()) return
      download.state = 'handed-off'
      download.status = '已再次请求浏览器保存，请查看下载列表。'
      showNotice('已再次请求保存' + label, 6000)
    } catch {
      showNotice('未能发起保存，请再次点击保存' + label)
    }
  }

  function startBrowserDownload() {
    const target = getTarget()
    if (!target || download.downloading) return
    if (!bufferBudget.clearRetained()) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
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
