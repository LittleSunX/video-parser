import {
  downloadMediaArchive,
  createBatchSession,
  clearBatchSession,
  saveArchivePart,
  type BatchSession,
  type BatchItemStatus,
} from '../utils/batch-download'
import { MediaDownloadError } from '../utils/download-error'
import { ref, onScopeDispose, type Ref } from 'vue'
import type { VideoInfo } from '../types/video'
import { downloadDirectVideo } from '../utils/auto-download'
import {
  buildCoverFilename,
  buildImageFilename,
  buildLivePhotoFilename,
  buildMusicFilename,
  buildVideoFilename,
  copyText,
  openDirectDownload,
  triggerDownload,
} from '../utils/download'

export function useMediaDownloads(
  video: Ref<VideoInfo | null>,
  showNotice: (message: string, duration?: number) => void,
) {
  const batchDownloading = ref(false)
  const batchProgress = ref('')
  const batchItems = ref<BatchItemStatus[]>([])
  const batchCanRetry = ref(false)
  const batchHasCache = ref(false)
  const batchPart = ref<{ number: number; count: number; size: number; final: boolean } | null>(
    null,
  )
  const batchCanContinue = ref(false)
  let batchSession: BatchSession | undefined
  let batchKey = ''
  let batchPreferLive = true
  const videoDownloading = ref(false)
  const downloadStatus = ref('')
  const downloadState = ref<'receiving' | 'handed-off' | 'fallback' | 'cancelled' | 'failed'>(
    'receiving',
  )
  const downloadNeedsReparse = ref(false)
  const nativeDownloads = new Set<() => void>()
  let nativeRequestNumber = 0
  let downloadController: AbortController | undefined
  let batchController: AbortController | undefined

  function startNativeDownload(url: string, filename: string, message: string) {
    const current = video.value
    const requestNumber = ++nativeRequestNumber
    downloadNeedsReparse.value = false
    downloadState.value = 'fallback'
    downloadStatus.value = message + '，请查看浏览器下载列表。'
    showNotice(downloadStatus.value, 6000)
    let dispose: (() => void) | undefined
    try {
      dispose = triggerDownload(url, filename, (error) => {
        if (dispose) nativeDownloads.delete(dispose)
        if (video.value !== current || requestNumber !== nativeRequestNumber) return
        downloadState.value = 'failed'
        downloadStatus.value = error.message
        downloadNeedsReparse.value = [
          'MEDIA_UNAVAILABLE',
          'INVALID_URL',
          'DOWNLOAD_FAILED',
        ].includes(error.code)
        showNotice(error.message, 6000)
      })
      if (typeof dispose === 'function') nativeDownloads.add(dispose)
    } catch {
      downloadState.value = 'failed'
      downloadStatus.value = '未能发起下载，请重试。'
      showNotice(downloadStatus.value)
    }
  }

  function stopNativeDownloads() {
    nativeRequestNumber++
    for (const dispose of nativeDownloads) dispose()
    nativeDownloads.clear()
  }

  async function handleCopyVideoUrl() {
    if (!video.value?.videoUrl) return
    try {
      await copyText(video.value.videoUrl)
      showNotice('视频地址已复制')
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '复制失败')
    }
  }

  async function handleDownloadVideo() {
    const current = video.value
    if (!current?.videoUrl || videoDownloading.value) return
    const controller = new AbortController()
    downloadController = controller
    videoDownloading.value = true
    downloadState.value = 'receiving'
    downloadNeedsReparse.value = false
    downloadStatus.value = '正在连接下载…'
    try {
      await downloadDirectVideo(current.videoUrl, buildVideoFilename(current), {
        signal: controller.signal,
        onProgress(received, total) {
          if (downloadController !== controller) return
          downloadStatus.value = total
            ? '正在下载 ' + Math.min(100, Math.round((received / total) * 100)) + '%'
            : '已接收 ' + (received / 1024 / 1024).toFixed(1) + ' MB'
        },
      })
      if (downloadController !== controller) return
      downloadState.value = 'handed-off'
      downloadStatus.value = '已请求浏览器保存，请查看下载列表；若未保存，可使用备用下载。'
      showNotice('视频已交给浏览器保存，请查看下载列表', 6000)
    } catch {
      if (controller.signal.aborted || downloadController !== controller) return
      startNativeDownload(current.videoUrl, buildVideoFilename(current), '已切换到备用下载')
    } finally {
      if (downloadController === controller) {
        downloadController = undefined
        videoDownloading.value = false
      }
    }
  }

  function cancelVideoDownload() {
    stopNativeDownloads()
    downloadNeedsReparse.value = false
    downloadController?.abort()
    downloadController = undefined
    videoDownloading.value = false
    downloadState.value = 'cancelled'
    downloadStatus.value = '已取消下载'
  }

  function handleOpenVideoLink() {
    if (!video.value?.videoUrl) return
    openDirectDownload(video.value.videoUrl)
  }

  function handleProxyDownloadVideo() {
    if (!video.value?.videoUrl || videoDownloading.value) return
    startNativeDownload(video.value.videoUrl, buildVideoFilename(video.value), '已发起备用下载')
  }

  function handleDownloadCover() {
    if (!video.value?.cover) return
    startNativeDownload(video.value.cover, buildCoverFilename(video.value), '已发起封面下载')
  }

  function handleDownloadImage(index: number) {
    const current = video.value
    const asset = current?.images?.[index]
    if (!current || !asset?.url) return
    startNativeDownload(
      asset.url,
      buildImageFilename(current, index),
      asset.watermarkFree
        ? '已发起第 ' + (index + 1) + ' 张无水印原图下载'
        : '已发起第 ' + (index + 1) + ' 张高清原图下载',
    )
  }

  function handleDownloadLivePhoto(index: number) {
    const current = video.value
    const asset = current?.images?.[index]
    if (!current || !asset?.livePhotoUrl) return
    startNativeDownload(
      asset.livePhotoUrl,
      buildLivePhotoFilename(current, index),
      '已发起第 ' + (index + 1) + ' 个实况视频下载',
    )
  }

  function handleDownloadAllPreferred() {
    return handleBatchDownload(true)
  }

  function handleDownloadAllOriginals() {
    return handleBatchDownload(false)
  }

  function stopBatchDownload() {
    batchController?.abort()
    batchController = undefined
    batchDownloading.value = false
    batchProgress.value = ''
    if (batchSession) clearBatchSession(batchSession)
    batchSession = undefined
    batchKey = ''
    batchPart.value = null
    batchCanContinue.value = false
    batchItems.value = []
    batchCanRetry.value = false
    batchHasCache.value = false
  }

  async function handleBatchDownload(preferLive: boolean) {
    if (batchDownloading.value) return
    const current = video.value
    if (!current?.images?.length) return
    const jobs = current.images.flatMap((asset, index) => {
      if (preferLive && asset.livePhotoUrl) {
        return [{ url: asset.livePhotoUrl, filename: buildLivePhotoFilename(current, index) }]
      }
      return asset.url ? [{ url: asset.url, filename: buildImageFilename(current, index) }] : []
    })
    if (!jobs.length) return

    const key = JSON.stringify(jobs)
    if (!batchSession || batchKey !== key) {
      stopBatchDownload()
      batchSession = createBatchSession(jobs)
      batchKey = key
    }
    const session = batchSession
    batchPreferLive = preferLive
    batchCanRetry.value = false
    batchCanContinue.value = false
    batchItems.value = session.items.map((item) => ({ ...item }))
    batchProgress.value = '正在获取未完成的文件…'
    const controller = new AbortController()
    batchController = controller
    batchDownloading.value = true
    try {
      await downloadMediaArchive(
        jobs,
        `抖音_${current.videoId}_${preferLive ? '动态优先' : '原图'}.zip`,
        controller.signal,
        (message) => {
          if (batchController === controller) batchProgress.value = message
        },
        session,
        (items) => {
          if (batchController === controller) batchItems.value = items
        },
      )
      if (batchController !== controller) return
      if (session.part) {
        const part = session.part
        batchPart.value = {
          number: part.number,
          count: part.count,
          size: part.blob.size,
          final: part.final,
        }
        batchHasCache.value = true
        showNotice(`第 ${part.number} 包已准备好，请点击保存`, 6000)
        return
      }
      batchSession = undefined
      batchHasCache.value = false
      showNotice('已请求浏览器保存 ZIP，解压后可查看全部文件', 6000)
    } catch (error) {
      if (controller.signal.aborted || batchController !== controller) return
      batchCanRetry.value = !(
        error instanceof MediaDownloadError &&
        ['TOO_LARGE', 'EXPIRED', 'INVALID_MEDIA'].includes(error.code)
      )
      batchHasCache.value = session.files.size > 0
      batchProgress.value = error instanceof Error ? error.message : '批量下载失败，请重试'
      showNotice(batchProgress.value, 6000)
    } finally {
      if (batchController === controller) {
        batchController = undefined
        batchDownloading.value = false
      }
    }
  }

  function saveBatchPart() {
    if (!batchSession?.part || batchDownloading.value) return
    const number = batchSession.part.number
    try {
      const final = saveArchivePart(batchSession)
      batchPart.value = null
      batchHasCache.value = false
      batchCanContinue.value = !final
      batchProgress.value = final
        ? '全部分包已请求浏览器保存，请查看下载列表'
        : `第 ${number} 包已请求浏览器保存，请确认后继续下一包`
      if (final) batchSession = undefined
    } catch {
      showNotice('未能发起保存，请再次点击保存当前包')
    }
  }

  function continueBatchDownload() {
    if (batchCanContinue.value) return handleBatchDownload(batchPreferLive)
  }

  function retryBatchDownload() {
    if (batchCanRetry.value) return handleBatchDownload(batchPreferLive)
  }

  function handleDownloadMusic() {
    const current = video.value
    if (!current?.musicUrl) return
    startNativeDownload(current.musicUrl, buildMusicFilename(current), '已发起背景音乐下载')
  }

  window.addEventListener?.('pagehide', stopBatchDownload)
  window.addEventListener?.('pagehide', stopNativeDownloads)
  onScopeDispose(() => {
    window.removeEventListener?.('pagehide', stopBatchDownload)
    window.removeEventListener?.('pagehide', stopNativeDownloads)
    stopBatchDownload()
    cancelVideoDownload()
  })
  return {
    batchDownloading,
    batchProgress,
    batchItems,
    batchCanRetry,
    batchHasCache,
    batchPart,
    batchCanContinue,
    saveBatchPart,
    continueBatchDownload,
    retryBatchDownload,
    videoDownloading,
    downloadStatus,
    downloadState,
    downloadNeedsReparse,
    handleCopyVideoUrl,
    handleDownloadVideo,
    cancelVideoDownload,
    handleOpenVideoLink,
    handleProxyDownloadVideo,
    handleDownloadCover,
    handleDownloadImage,
    handleDownloadLivePhoto,
    handleDownloadAllPreferred,
    handleDownloadAllOriginals,
    stopBatchDownload,
    handleDownloadMusic,
  }
}
