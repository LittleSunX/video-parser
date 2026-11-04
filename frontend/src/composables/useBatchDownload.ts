import { computed, ref, onScopeDispose, type Ref } from 'vue'
import type { VideoInfo } from '../types/video'
import {
  downloadMediaArchive,
  createBatchSession,
  clearBatchSession,
  saveArchivePart,
  type BatchSession,
  type BatchItemStatus,
  type ArchivePart,
} from '../utils/batch-download'
import { MediaDownloadError } from '../utils/download-error'
import {
  PAGE_BUFFER_BUDGET_BYTES,
  ZIP_PART_SOURCE_BYTES,
  type DownloadBufferBudget,
} from '../utils/download-buffer'
import { createPreparedDownload, PREPARED_DOWNLOAD_TTL_MS } from '../utils/prepared-download'
import { buildImageFilename, buildLivePhotoFilename } from '../utils/download'
import { imageDownloadTargets } from '../utils/image-download-targets'

type PartSummary = { number: number; count: number; size: number; final: boolean }
type BatchPhase =
  | { kind: 'idle' | 'receiving' | 'continuable' | 'handed-off' }
  | { kind: 'ready'; part: PartSummary; saveFailed: boolean }
  | { kind: 'failed'; retryable: boolean }

function partSummary(part: ArchivePart): PartSummary {
  return { number: part.number, count: part.count, size: part.blob.size, final: part.final }
}

/** Owns one archive session; admission and retained bytes use the page's shared budget. */
export function useBatchDownload({
  video,
  showNotice,
  bufferBudget,
  downloadSingle,
}: {
  video: Ref<VideoInfo | null>
  showNotice: (message: string, duration?: number) => void
  bufferBudget: DownloadBufferBudget
  downloadSingle: (index: number, live: boolean) => void | Promise<void>
}) {
  const phase = ref<BatchPhase>({ kind: 'idle' })
  const batchDownloading = computed(() => phase.value.kind === 'receiving')
  const batchCanContinue = computed(() => phase.value.kind === 'continuable')
  const batchCanRetry = computed(() => phase.value.kind === 'failed' && phase.value.retryable)
  const batchFailed = computed(
    () => phase.value.kind === 'failed' || (phase.value.kind === 'ready' && phase.value.saveFailed),
  )
  const batchPart = computed(() => (phase.value.kind === 'ready' ? phase.value.part : null))
  const pendingBatch = computed(() => !!batchPart.value || batchCanContinue.value)
  const batchProgress = ref('')
  const batchItems = ref<BatchItemStatus[]>([])
  const batchHasCache = ref(false)
  let batchSession: BatchSession | undefined
  let batchKey = ''
  let batchPreferLive = true
  let batchController: AbortController | undefined
  let releaseBatchBuffer: (() => void) | undefined
  let batchExpiry: ReturnType<typeof setTimeout> | undefined
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

  function stopBatchDownload() {
    batchController?.abort()
    batchController = undefined
    releaseBatchBuffer?.()
    releaseBatchBuffer = undefined
    clearTimeout(batchExpiry)
    batchExpiry = undefined
    batchPrepared.clear()
    bufferBudget.retain(batchOwner, 0)
    batchProgress.value = ''
    if (batchSession) clearBatchSession(batchSession)
    batchSession = undefined
    batchKey = ''
    phase.value = { kind: 'idle' }
    batchItems.value = []
    batchHasCache.value = false
  }

  async function handleBatchDownload(preferLive: boolean) {
    if (batchDownloading.value) return
    const current = video.value
    if (!current?.images?.length) return
    const targets = imageDownloadTargets(current, preferLive)
    if (!targets.length) return
    if (targets.length === 1) {
      const target = targets[0]!
      return downloadSingle(target.index, target.live)
    }
    const jobs = targets.map((target) => ({
      url: target.url,
      filename: target.live
        ? buildLivePhotoFilename(current, target.index)
        : buildImageFilename(current, target.index),
    }))
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
    batchItems.value = session.items.map((item) => ({ ...item }))
    batchProgress.value = '正在获取未完成的文件…'
    const controller = new AbortController()
    batchController = controller
    phase.value = { kind: 'receiving' }
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
        phase.value = { kind: 'ready', part: partSummary(part), saveFailed: false }
        batchHasCache.value = true
        showNotice(`第 ${part.number} 包已准备好，请点击保存`, 6000)
        return
      }
      batchSession = undefined
      phase.value = { kind: 'handed-off' }
      batchHasCache.value = false
      showNotice('已请求浏览器保存 ZIP，解压后可查看全部文件', 6000)
    } catch (error) {
      if (controller.signal.aborted || batchController !== controller) return
      if (session.part) {
        const part = session.part
        batchPrepared.prepare(part.blob, part.filename)
        bufferBudget.retain(batchOwner, part.blob.size)
        phase.value = { kind: 'ready', part: partSummary(part), saveFailed: true }
        batchHasCache.value = true
        batchProgress.value = '文件已打包，未能发起保存，请点击保存当前包。'
        showNotice(batchProgress.value, 6000)
        return
      }
      phase.value = {
        kind: 'failed',
        retryable: !(
          error instanceof MediaDownloadError &&
          ['TOO_LARGE', 'EXPIRED', 'INVALID_MEDIA'].includes(error.code)
        ),
      }
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
      }
    }
  }

  function saveBatchPart() {
    if (!video.value?.images?.length || !batchSession?.part || bufferBudget.busy.value) return
    const number = batchSession.part.number
    try {
      const final = saveArchivePart(batchSession, prepareAndSaveBatch)
      phase.value = { kind: final ? 'handed-off' : 'continuable' }
      batchHasCache.value = false
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
      if (phase.value.kind === 'failed') phase.value = { kind: 'handed-off' }
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
  onScopeDispose(() => {
    window.removeEventListener?.('pagehide', stopBatchDownload)
    stopBatchDownload()
  })
  return {
    canSaveBatchAgain: batchPrepared.canSave,
    saveBatchAgain,
    batchPartLimitMiB: ZIP_PART_SOURCE_BYTES / 1024 / 1024,
    batchDownloading,
    batchProgress,
    batchItems,
    batchCanRetry,
    batchFailed,
    pendingBatch,
    batchHasCache,
    batchPart,
    batchCanContinue,
    saveBatchPart,
    continueBatchDownload,
    retryBatchDownload,
    handleDownloadAllPreferred: () => handleBatchDownload(true),
    handleDownloadAllOriginals: () => handleBatchDownload(false),
    stopBatchDownload,
  }
}
