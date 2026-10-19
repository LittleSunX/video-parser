import { ref, shallowRef, computed, onScopeDispose } from 'vue'
import { parseVideo } from '../api/video'
import {
  createParseDiagnostics,
  ParseError,
  serializeParseDiagnostics,
  type ParseDiagnostics,
} from '../api/parse-error'
import { copyText } from '../utils/download'
import type { VideoInfo } from '../types/video'
import { useNotice } from './useNotice'
import { imageDownloadLabel, imageDownloadTargets, useMediaDownloads } from './useMediaDownloads'

export function useVideoPage() {
  const input = ref('')
  const loading = ref(false)
  const errorMessage = ref('')
  const errorDiagnostics = shallowRef<ParseDiagnostics>()
  const copyingProblemInfo = ref(false)
  let copyRequestNumber = 0
  const video = ref<VideoInfo | null>(null)
  const previewing = ref(false)
  const { notice, showNotice, clearNotice } = useNotice()
  const downloads = useMediaDownloads(
    computed(() => (loading.value ? null : video.value)),
    showNotice,
  )
  const {
    stopBatchDownload,
    cancelVideoDownload,
    downloadStatus,
    coverDownload,
    musicDownload,
    imageDownload,
  } = downloads
  let parseController: AbortController | undefined
  const canSubmit = computed(() => input.value.trim().length > 0 && !loading.value)
  const livePhotoCount = computed(
    () => video.value?.images?.filter((image) => !!image.livePhotoUrl).length ?? 0,
  )
  const preferredDownloads = computed(() => imageDownloadTargets(video.value, true))
  const originalDownloads = computed(() => imageDownloadTargets(video.value, false))
  const preferredDownloadCount = computed(() => preferredDownloads.value.length)
  const originalDownloadCount = computed(() => originalDownloads.value.length)
  const preferredDownloadLabel = computed(() => imageDownloadLabel(preferredDownloads.value))
  const originalDownloadLabel = computed(() =>
    originalDownloadCount.value > 1
      ? '打包下载全部原图'
      : imageDownloadLabel(originalDownloads.value),
  )
  const hasArchiveDownloads = computed(
    () => preferredDownloadCount.value > 1 || originalDownloadCount.value > 1,
  )
  const parseWarning = computed(() => {
    if (!video.value || previewing.value) return ''
    if (video.value.mediaType === 'image' && video.value.imagesComplete === true) return ''
    if (video.value.imagesComplete !== false && video.value.parseStatus !== 'unverified') return ''
    return video.value.parseReason === 'timeout'
      ? '解析等待超时，已保留获取到的资源；资源可能不完整，可重新解析尝试补齐。'
      : '已获取可用资源，尚无法确认图片及实况资源是否齐全；可下载已有资源或重新解析尝试补齐。'
  })
  const imageQualityNotice = computed(() =>
    !previewing.value &&
    video.value?.mediaType === 'image' &&
    video.value.imagesComplete === true &&
    video.value.images?.some((image) => !!image.url && !image.watermarkFree)
      ? '图片已获取，无水印状态未确认；可下载高清原图。'
      : '',
  )

  async function handleParse() {
    if (!canSubmit.value) return

    resetProblemInfo()
    const started = performance.now()
    stopBatchDownload()
    cancelVideoDownload()
    coverDownload.reset()
    musicDownload.reset()
    imageDownload.reset()
    downloadStatus.value = ''
    const controller = new AbortController()
    parseController = controller
    const timeout = window.setTimeout(() => {
      controller.abort(new DOMException('解析超时', 'TimeoutError'))
    }, 35000)
    loading.value = true
    errorMessage.value = ''
    video.value = null
    previewing.value = false
    clearNotice()

    try {
      const result = await parseVideo(input.value.trim(), controller.signal, (candidate) => {
        if (parseController !== controller || controller.signal.aborted) return
        video.value = candidate
        previewing.value = true
      })
      if (parseController !== controller || controller.signal.aborted) return
      video.value = result
      previewing.value = false
      if (parseWarning.value) {
        showNotice('已获取可用资源，完整性尚未确认', 6000)
      } else if (video.value.mediaType === 'image' && livePhotoCount.value > 0) {
        showNotice('实况图文解析成功')
      } else {
        showNotice(video.value.mediaType === 'image' ? '图文解析成功' : '视频解析成功')
      }
    } catch (error) {
      if (parseController !== controller) return
      video.value = null
      previewing.value = false
      errorMessage.value = controller.signal.aborted
        ? controller.signal.reason?.name === 'TimeoutError'
          ? '解析超时，请重试'
          : ''
        : error instanceof Error
          ? error.message
          : '作品解析失败，请稍后重试'
      if (errorMessage.value) {
        errorDiagnostics.value =
          error instanceof ParseError && error.diagnostics
            ? error.diagnostics
            : createParseDiagnostics({
                code: controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'UNKNOWN_ERROR',
                stage: 'request',
                durationMs: performance.now() - started,
              })
      }
    } finally {
      window.clearTimeout(timeout)
      if (parseController === controller) {
        parseController = undefined
        loading.value = false
      }
    }
  }

  function cancelParse() {
    resetProblemInfo()
    errorMessage.value = ''
    parseController?.abort()
    parseController = undefined
    loading.value = false
    if (previewing.value) video.value = null
    previewing.value = false
    showNotice('已取消解析')
  }

  function handleClear() {
    resetProblemInfo()
    parseController?.abort()
    parseController = undefined
    loading.value = false
    stopBatchDownload()
    cancelVideoDownload()
    coverDownload.reset()
    musicDownload.reset()
    imageDownload.reset()
    downloadStatus.value = ''
    input.value = ''
    video.value = null
    previewing.value = false
    errorMessage.value = ''
    clearNotice()
  }

  function resetProblemInfo() {
    copyRequestNumber++
    errorDiagnostics.value = undefined
    copyingProblemInfo.value = false
  }

  async function copyProblemInfo() {
    const report = errorDiagnostics.value
    if (!report || loading.value || copyingProblemInfo.value) return
    const requestNumber = ++copyRequestNumber
    copyingProblemInfo.value = true
    try {
      await copyText(serializeParseDiagnostics(report))
      if (requestNumber === copyRequestNumber && report === errorDiagnostics.value)
        showNotice('问题信息已复制，不含分享文案和媒体地址')
    } catch {
      if (requestNumber === copyRequestNumber && report === errorDiagnostics.value)
        showNotice('复制失败，请重试或检查浏览器的剪贴板权限', 6000)
    } finally {
      if (requestNumber === copyRequestNumber) copyingProblemInfo.value = false
    }
  }

  onScopeDispose(() => {
    resetProblemInfo()
    parseController?.abort()
    parseController = undefined
  })
  return {
    input,
    loading,
    errorMessage,
    errorDiagnostics,
    copyingProblemInfo,
    copyProblemInfo,
    video,
    previewing,
    notice,
    canSubmit,
    livePhotoCount,
    preferredDownloadCount,
    originalDownloadCount,
    preferredDownloadLabel,
    originalDownloadLabel,
    hasArchiveDownloads,
    parseWarning,
    imageQualityNotice,
    handleParse,
    cancelParse,
    handleClear,
    ...downloads,
  }
}
