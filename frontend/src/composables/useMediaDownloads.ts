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
  const videoDownloading = ref(false)
  const downloadStatus = ref('')
  const downloadState = ref<'receiving' | 'handed-off' | 'fallback' | 'cancelled'>('receiving')
  let downloadController: AbortController | undefined
  let batchController: AbortController | undefined

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
      triggerDownload(current.videoUrl, buildVideoFilename(current))
      downloadState.value = 'fallback'
      showNotice('已切换备用下载，请查看浏览器下载列表', 6000)
      downloadStatus.value = '已切换到备用下载，请查看浏览器下载列表；速度较慢时可使用“打开直链”。'
    } finally {
      if (downloadController === controller) {
        downloadController = undefined
        videoDownloading.value = false
      }
    }
  }

  function cancelVideoDownload() {
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
    triggerDownload(video.value.videoUrl, buildVideoFilename(video.value))
    downloadState.value = 'fallback'
    downloadStatus.value = '已发起备用下载，请查看浏览器下载列表。'
    showNotice('已发起备用下载，请查看浏览器下载列表', 6000)
  }

  function handleDownloadCover() {
    if (!video.value?.cover) return
    triggerDownload(video.value.cover, buildCoverFilename(video.value))
    showNotice('已发起封面下载')
  }

  function handleDownloadImage(index: number) {
    const current = video.value
    const asset = current?.images?.[index]
    if (!current || !asset?.url) return
    triggerDownload(asset.url, buildImageFilename(current, index))
    showNotice(
      asset.watermarkFree
        ? '已发起第 ' + (index + 1) + ' 张无水印原图下载'
        : '已发起第 ' + (index + 1) + ' 张高清原图下载',
    )
  }

  function handleDownloadLivePhoto(index: number) {
    const current = video.value
    const asset = current?.images?.[index]
    if (!current || !asset?.livePhotoUrl) return
    triggerDownload(asset.livePhotoUrl, buildLivePhotoFilename(current, index))
    showNotice('已发起第 ' + (index + 1) + ' 个实况视频下载')
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

    const controller = new AbortController()
    batchController = controller
    batchDownloading.value = true
    try {
      for (let index = 0; index < jobs.length; index += 1) {
        if (controller.signal.aborted) return
        triggerDownload(jobs[index].url, jobs[index].filename)
        batchProgress.value = '已发起 ' + (index + 1) + ' / ' + jobs.length + ' 个下载请求'
        if (index < jobs.length - 1) await delay(300)
      }
      showNotice('已发起全部下载，请在浏览器下载列表中查看；如有提示，请允许多个文件下载')
    } catch {
      showNotice('批量下载中断，请检查浏览器下载列表后重试')
    } finally {
      if (batchController === controller) {
        batchController = undefined
        batchDownloading.value = false
      }
    }
  }

  function handleDownloadMusic() {
    const current = video.value
    if (!current?.musicUrl) return
    triggerDownload(current.musicUrl, buildMusicFilename(current))
    showNotice('已发起背景音乐下载')
  }

  function delay(milliseconds: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
  }

  onScopeDispose(() => {
    stopBatchDownload()
    cancelVideoDownload()
  })
  return {
    batchDownloading,
    batchProgress,
    videoDownloading,
    downloadStatus,
    downloadState,
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
