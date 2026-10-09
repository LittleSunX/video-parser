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
import { fetchMediaBlob } from '../utils/auto-download'
import { useFileDownload } from './useFileDownload'
import {
  createDownloadBufferBudget,
  PAGE_BUFFER_BUDGET_BYTES,
  ZIP_PART_SOURCE_BYTES,
} from '../utils/download-buffer'
import { createPreparedDownload, PREPARED_DOWNLOAD_TTL_MS } from '../utils/prepared-download'
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
  const bufferBudget = createDownloadBufferBudget()
  const coverDownload = useFileDownload({
    label: '封面',
    kind: 'image',
    getTarget: () => {
      const current = video.value
      return current?.cover
        ? { url: current.cover, filename: buildCoverFilename(current) }
        : undefined
    },
    showNotice,
    bufferBudget,
  })
  const musicDownload = useFileDownload({
    label: '背景音乐',
    kind: 'audio',
    getTarget: () => {
      const current = video.value
      return current?.musicUrl
        ? { url: current.musicUrl, filename: buildMusicFilename(current) }
        : undefined
    },
    showNotice,
    bufferBudget,
  })
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
  let releaseVideoBuffer: (() => void) | undefined
  let releaseBatchBuffer: (() => void) | undefined
  let batchExpiry: ReturnType<typeof setTimeout> | undefined
  const videoPrepared = createPreparedDownload(() => bufferBudget.retain(videoOwner, 0))
  const videoOwner = bufferBudget.register(() => {
    videoPrepared.clear()
    bufferBudget.retain(videoOwner, 0)
  })
  const batchPrepared = createPreparedDownload(expireBatchFiles)
  const batchOwner = bufferBudget.register(stopBatchDownload)

  function expireBatchFiles() {
    bufferBudget.retain(batchOwner, 0)
    if (batchSession?.part || batchSession?.files.size) {
      stopBatchDownload()
      batchProgress.value = '当前包暂存已到期，请重新准备下载。'
    }
  }

  function prepareAndSaveBatch(blob: Blob, filename: string) {
    batchPrepared.prepare(blob, filename)
    bufferBudget.retain(batchOwner, blob.size)
    batchPrepared.save()
  }

  function startNativeDownload(url: string, filename: string, message: string) {
    if (!bufferBudget.clearRetained()) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
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
    const release = bufferBudget.acquire(videoOwner, PAGE_BUFFER_BUDGET_BYTES)
    if (!release) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
    videoPrepared.clear()
    bufferBudget.retain(videoOwner, 0)
    releaseVideoBuffer = release
    const controller = new AbortController()
    downloadController = controller
    videoDownloading.value = true
    downloadState.value = 'receiving'
    downloadNeedsReparse.value = false
    downloadStatus.value = '正在连接下载…'
    try {
      const blob = await fetchMediaBlob(current.videoUrl, {
        signal: controller.signal,
        onProgress(received, total) {
          if (downloadController !== controller) return
          downloadStatus.value = total
            ? '正在下载 ' + Math.min(100, Math.round((received / total) * 100)) + '%'
            : '已接收 ' + (received / 1024 / 1024).toFixed(1) + ' MB'
        },
      })
      if (downloadController !== controller) return
      videoPrepared.prepare(blob, buildVideoFilename(current))
      bufferBudget.retain(videoOwner, blob.size)
      videoPrepared.save()
      downloadState.value = 'handed-off'
      downloadStatus.value = '已请求浏览器保存，请查看下载列表；未保存时可在 30 秒内再次保存。'
      showNotice('视频已交给浏览器保存，请查看下载列表', 6000)
    } catch {
      if (controller.signal.aborted || downloadController !== controller) return
      if (videoPrepared.canSave.value) {
        downloadState.value = 'failed'
        downloadStatus.value = '文件已接收，未能发起保存，请点击再次保存。'
        showNotice(downloadStatus.value, 6000)
      } else {
        release()
        releaseVideoBuffer = undefined
        startNativeDownload(current.videoUrl, buildVideoFilename(current), '已切换到备用下载')
      }
    } finally {
      release()
      if (downloadController === controller) {
        releaseVideoBuffer = undefined
        downloadController = undefined
        videoDownloading.value = false
      }
    }
  }

  function saveVideoAgain() {
    if (!video.value?.videoUrl || bufferBudget.busy.value) return
    try {
      if (!videoPrepared.save()) return
      downloadState.value = 'handed-off'
      downloadStatus.value = '已再次请求浏览器保存，请查看下载列表。'
      showNotice('已再次请求保存视频', 6000)
    } catch {
      showNotice('未能发起保存，请再次点击保存视频')
    }
  }

  function cancelVideoDownload() {
    stopNativeDownloads()
    downloadNeedsReparse.value = false
    downloadController?.abort()
    downloadController = undefined
    releaseVideoBuffer?.()
    releaseVideoBuffer = undefined
    videoPrepared.clear()
    bufferBudget.retain(videoOwner, 0)
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
    releaseBatchBuffer?.()
    releaseBatchBuffer = undefined
    clearTimeout(batchExpiry)
    batchExpiry = undefined
    batchPrepared.clear()
    bufferBudget.retain(batchOwner, 0)
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
    const release = bufferBudget.acquire(batchOwner, PAGE_BUFFER_BUDGET_BYTES)
    if (!release) {
      showNotice('请先完成或取消当前下载任务')
      return
    }

    const key = JSON.stringify(jobs)
    if (!batchSession || batchKey !== key) {
      stopBatchDownload()
      batchSession = createBatchSession(jobs)
      batchKey = key
    }
    const session = batchSession
    clearTimeout(batchExpiry)
    batchPrepared.clear()
    bufferBudget.retain(
      batchOwner,
      [...session.files.values()].reduce((sum, file) => sum + file.size, 0),
    )
    releaseBatchBuffer = release
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
        prepareAndSaveBatch,
      )
      if (batchController !== controller) return
      if (session.part) {
        const part = session.part
        batchPrepared.prepare(part.blob, part.filename)
        bufferBudget.retain(batchOwner, part.blob.size)
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
      if (session.part) {
        const part = session.part
        batchPrepared.prepare(part.blob, part.filename)
        bufferBudget.retain(batchOwner, part.blob.size)
        batchPart.value = {
          number: part.number,
          count: part.count,
          size: part.blob.size,
          final: part.final,
        }
        batchHasCache.value = true
        batchProgress.value = '文件已打包，未能发起保存，请点击保存当前包。'
        showNotice(batchProgress.value, 6000)
        return
      }
      batchCanRetry.value = !(
        error instanceof MediaDownloadError &&
        ['TOO_LARGE', 'EXPIRED', 'INVALID_MEDIA'].includes(error.code)
      )
      batchHasCache.value = session.files.size > 0
      bufferBudget.retain(
        batchOwner,
        [...session.files.values()].reduce((sum, file) => sum + file.size, 0),
      )
      if (session.files.size) batchExpiry = setTimeout(expireBatchFiles, PREPARED_DOWNLOAD_TTL_MS)
      batchProgress.value = error instanceof Error ? error.message : '批量下载失败，请重试'
      showNotice(batchProgress.value, 6000)
    } finally {
      release()
      if (batchController === controller) {
        releaseBatchBuffer = undefined
        batchController = undefined
        batchDownloading.value = false
      }
    }
  }

  function saveBatchPart() {
    if (!video.value?.images?.length || !batchSession?.part || bufferBudget.busy.value) return
    const number = batchSession.part.number
    try {
      const final = saveArchivePart(batchSession, prepareAndSaveBatch)
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

  function saveBatchAgain() {
    if (!video.value?.images?.length || bufferBudget.busy.value) return
    if (batchSession?.part) return saveBatchPart()
    try {
      if (!batchPrepared.save()) return
      batchProgress.value = '已再次请求浏览器保存当前 ZIP，请查看下载列表。'
      showNotice('已再次请求保存 ZIP', 6000)
    } catch {
      showNotice('未能发起保存，请再次点击保存当前 ZIP')
    }
  }

  function continueBatchDownload() {
    if (batchCanContinue.value) return handleBatchDownload(batchPreferLive)
  }

  function retryBatchDownload() {
    if (batchCanRetry.value) return handleBatchDownload(batchPreferLive)
  }

  window.addEventListener?.('pagehide', stopBatchDownload)
  window.addEventListener?.('pagehide', stopNativeDownloads)
  window.addEventListener?.('pagehide', cancelVideoDownload)
  onScopeDispose(() => {
    window.removeEventListener?.('pagehide', stopBatchDownload)
    window.removeEventListener?.('pagehide', stopNativeDownloads)
    window.removeEventListener?.('pagehide', cancelVideoDownload)
    stopBatchDownload()
    cancelVideoDownload()
  })
  return {
    bufferBusy: bufferBudget.busy,
    canSaveVideoAgain: videoPrepared.canSave,
    saveVideoAgain,
    canSaveBatchAgain: batchPrepared.canSave,
    saveBatchAgain,
    batchPartLimitMiB: ZIP_PART_SOURCE_BYTES / 1024 / 1024,
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
    coverDownload,
    handleDownloadImage,
    handleDownloadLivePhoto,
    handleDownloadAllPreferred,
    handleDownloadAllOriginals,
    stopBatchDownload,
    musicDownload,
  }
}
