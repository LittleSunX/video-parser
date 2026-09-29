import { ref, computed, onScopeDispose } from 'vue'
import { parseVideo } from '../api/video'
import type { VideoInfo } from '../types/video'
import { useNotice } from './useNotice'
import { useMediaDownloads } from './useMediaDownloads'

export function useVideoPage() {
  const input = ref('')
  const loading = ref(false)
  const errorMessage = ref('')
  const video = ref<VideoInfo | null>(null)
  const { notice, showNotice, clearNotice } = useNotice()
  const downloads = useMediaDownloads(video, showNotice)
  const { stopBatchDownload, cancelVideoDownload, downloadStatus } = downloads
  let parseController: AbortController | undefined
  const canSubmit = computed(() => input.value.trim().length > 0 && !loading.value)
  const livePhotoCount = computed(
    () => video.value?.images?.filter((image) => !!image.livePhotoUrl).length ?? 0,
  )

  async function handleParse() {
    if (!canSubmit.value) return

    stopBatchDownload()
    cancelVideoDownload()
    downloadStatus.value = ''
    const controller = new AbortController()
    parseController = controller
    const timeout = window.setTimeout(() => {
      controller.abort(new DOMException('解析超时', 'TimeoutError'))
    }, 35000)
    loading.value = true
    errorMessage.value = ''
    video.value = null
    clearNotice()

    try {
      const result = await parseVideo(input.value.trim(), controller.signal)
      if (parseController !== controller || controller.signal.aborted) return
      video.value = result
      if (video.value.mediaType === 'image' && livePhotoCount.value > 0) {
        showNotice('实况图文解析成功')
      } else {
        showNotice(video.value.mediaType === 'image' ? '图文解析成功' : '视频解析成功')
      }
    } catch (error) {
      if (parseController !== controller) return
      errorMessage.value = controller.signal.aborted
        ? controller.signal.reason?.name === 'TimeoutError'
          ? '解析超时，请重试'
          : ''
        : error instanceof Error
          ? error.message
          : '作品解析失败，请稍后重试'
    } finally {
      window.clearTimeout(timeout)
      if (parseController === controller) {
        parseController = undefined
        loading.value = false
      }
    }
  }

  function cancelParse() {
    parseController?.abort()
    parseController = undefined
    loading.value = false
    showNotice('已取消解析')
  }

  function handleClear() {
    stopBatchDownload()
    cancelVideoDownload()
    downloadStatus.value = ''
    input.value = ''
    video.value = null
    errorMessage.value = ''
    clearNotice()
  }

  onScopeDispose(() => {
    parseController?.abort()
    parseController = undefined
  })
  return {
    input,
    loading,
    errorMessage,
    video,
    notice,
    canSubmit,
    livePhotoCount,
    handleParse,
    cancelParse,
    handleClear,
    ...downloads,
  }
}
