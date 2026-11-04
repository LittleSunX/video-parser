import { useBatchDownload } from './useBatchDownload'
export { imageDownloadTargets, imageDownloadLabel } from '../utils/image-download-targets'
import { computed, ref, onScopeDispose, type Ref } from 'vue'
import type { VideoInfo } from '../types/video'
import { fetchMediaBlob } from '../utils/auto-download'
import { useFileDownload } from './useFileDownload'
import {
  createDownloadBufferBudget,
  PAGE_BUFFER_BUDGET_BYTES,
  VIDEO_BUFFER_BYTES,
} from '../utils/download-buffer'
import { createPreparedDownload } from '../utils/prepared-download'
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
  const selectedImageIndex = ref(0)
  const imageDownloadName = computed(() => '第 ' + (selectedImageIndex.value + 1) + ' 张图片')
  const batch = useBatchDownload({
    video,
    showNotice,
    bufferBudget,
    downloadSingle: (index, live) =>
      live ? handleDownloadLivePhoto(index) : handleDownloadImage(index),
  })
  const { pendingBatch } = batch

  function canStartSingleDownload() {
    if (!pendingBatch.value) return true
    showNotice('请先保存或结束当前分包任务')
    return false
  }

  const imageDownload = useFileDownload({
    label: '图片',
    kind: 'image',
    getTarget: () => {
      const current = video.value
      const asset = current?.images?.[selectedImageIndex.value]
      return current && asset?.url
        ? { url: asset.url, filename: buildImageFilename(current, selectedImageIndex.value) }
        : undefined
    },
    showNotice,
    bufferBudget,
    canStart: canStartSingleDownload,
  })
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
    canStart: canStartSingleDownload,
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
    canStart: canStartSingleDownload,
  })
  const videoDownloading = ref(false)
  const downloadStatus = ref('')
  const downloadLabel = ref('视频')
  const downloadState = ref<'receiving' | 'handed-off' | 'fallback' | 'cancelled' | 'failed'>(
    'receiving',
  )
  const downloadNeedsReparse = ref(false)
  const nativeDownloads = new Set<() => void>()
  let nativeRequestNumber = 0
  let downloadController: AbortController | undefined
  let releaseVideoBuffer: (() => void) | undefined
  const videoPrepared = createPreparedDownload(() => bufferBudget.retain(videoOwner, 0))
  const videoOwner = bufferBudget.register(() => {
    videoPrepared.clear()
    bufferBudget.retain(videoOwner, 0)
  })
  function startNativeDownload(url: string, filename: string, message: string, label = '视频') {
    if (!canStartSingleDownload()) return
    if (!bufferBudget.clearRetained()) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
    const current = video.value
    const requestNumber = ++nativeRequestNumber
    downloadLabel.value = label
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
    if (!current?.videoUrl) return
    if (
      typeof current.videoSize === 'number' &&
      Number.isSafeInteger(current.videoSize) &&
      current.videoSize > VIDEO_BUFFER_BYTES
    ) {
      startNativeDownload(
        current.videoUrl,
        buildVideoFilename(current),
        '文件较大，已交给浏览器下载',
      )
      return
    }
    return downloadSingleVideo(current.videoUrl, buildVideoFilename(current), '视频')
  }

  /** 普通视频与单个实况共用直连、进度、缓冲保存及代理回退。 */
  async function downloadSingleVideo(url: string, filename: string, label: string) {
    if (videoDownloading.value || !canStartSingleDownload()) return
    const release = bufferBudget.acquire(videoOwner, PAGE_BUFFER_BUDGET_BYTES)
    if (!release) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
    // 旧代理错误不影响新直连；已有浏览器下载仍留给浏览器继续接收。
    nativeRequestNumber++
    videoPrepared.clear()
    bufferBudget.retain(videoOwner, 0)
    releaseVideoBuffer = release
    const controller = new AbortController()
    downloadController = controller
    videoDownloading.value = true
    downloadLabel.value = label
    downloadState.value = 'receiving'
    downloadNeedsReparse.value = false
    downloadStatus.value = '正在连接下载…'
    try {
      const blob = await fetchMediaBlob(url, {
        signal: controller.signal,
        // 持续收到数据时不限总时长，连接和读取停滞仍由各自超时保护。
        totalTimeoutMs: 0,
        onProgress(received, total) {
          if (downloadController !== controller) return
          downloadStatus.value = total
            ? '正在下载 ' + Math.min(100, Math.round((received / total) * 100)) + '%'
            : '已接收 ' + (received / 1024 / 1024).toFixed(1) + ' MB'
        },
      })
      if (downloadController !== controller) return
      videoPrepared.prepare(blob, filename)
      bufferBudget.retain(videoOwner, blob.size)
      videoPrepared.save()
      downloadState.value = 'handed-off'
      downloadStatus.value = '已请求浏览器保存，请查看下载列表；未保存时可在 30 秒内再次保存。'
      showNotice(label + '已交给浏览器保存，请查看下载列表', 6000)
    } catch {
      if (controller.signal.aborted || downloadController !== controller) return
      if (videoPrepared.canSave.value) {
        downloadState.value = 'failed'
        downloadStatus.value = '文件已接收，未能发起保存，请点击再次保存。'
        showNotice(downloadStatus.value, 6000)
      } else {
        release()
        releaseVideoBuffer = undefined
        startNativeDownload(url, filename, '已切换到备用下载', label)
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
    if (!video.value || bufferBudget.busy.value) return
    try {
      if (!videoPrepared.save()) return
      downloadState.value = 'handed-off'
      downloadStatus.value = '已再次请求浏览器保存，请查看下载列表。'
      showNotice('已再次请求保存' + downloadLabel.value, 6000)
    } catch {
      showNotice('未能发起保存，请再次点击保存' + downloadLabel.value)
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
    if (!current || !asset?.url || !canStartSingleDownload()) return
    if (bufferBudget.busy.value) {
      showNotice('请先完成或取消当前下载任务')
      return
    }
    selectedImageIndex.value = index
    return imageDownload.start()
  }

  async function handleDownloadLivePhoto(index: number) {
    const current = video.value
    const asset = current?.images?.[index]
    if (!current || !asset?.livePhotoUrl) return
    return downloadSingleVideo(
      asset.livePhotoUrl,
      buildLivePhotoFilename(current, index),
      '第 ' + (index + 1) + ' 张实况视频',
    )
  }

  window.addEventListener?.('pagehide', stopNativeDownloads)
  window.addEventListener?.('pagehide', cancelVideoDownload)
  onScopeDispose(() => {
    window.removeEventListener?.('pagehide', stopNativeDownloads)
    window.removeEventListener?.('pagehide', cancelVideoDownload)
    cancelVideoDownload()
  })
  return {
    bufferBusy: bufferBudget.busy,
    canSaveVideoAgain: videoPrepared.canSave,
    saveVideoAgain,
    ...batch,
    videoDownloading,
    downloadStatus,
    downloadLabel,
    downloadState,
    downloadNeedsReparse,
    handleCopyVideoUrl,
    handleDownloadVideo,
    cancelVideoDownload,
    handleOpenVideoLink,
    handleProxyDownloadVideo,
    coverDownload,
    imageDownload,
    imageDownloadName,
    handleDownloadImage,
    handleDownloadLivePhoto,
    musicDownload,
  }
}
