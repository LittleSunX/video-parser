import { imageFilename } from '../../../shared/media'
import { createMediaArchive } from './media-archive'
import { fetchMediaBlob, saveBlob } from './auto-download'
import { buildDownloadUrl } from './download'
import { MediaDownloadError } from './download-error'
import { ZIP_PART_SOURCE_BYTES } from './download-buffer'

export interface DownloadJob {
  url: string
  filename: string
}
export const MAX_PART_BYTES = ZIP_PART_SOURCE_BYTES

export interface BatchItemStatus {
  filename: string
  state: 'pending' | 'receiving' | 'ready' | 'packed' | 'failed'
  message: string
}

export interface ArchivePart {
  blob: Blob
  filename: string
  number: number
  count: number
  final: boolean
}

export interface BatchSession {
  files: Map<string, Blob>
  items: BatchItemStatus[]
  nextIndex: number
  partNumber: number
  part?: ArchivePart
  maxPartBytes: number
}

export function createBatchSession(
  jobs: DownloadJob[],
  maxPartBytes = MAX_PART_BYTES,
): BatchSession {
  return {
    files: new Map(),
    nextIndex: 0,
    partNumber: 1,
    maxPartBytes,
    items: jobs.map((job) => ({ filename: job.filename, state: 'pending', message: '等待获取' })),
  }
}

export function clearBatchSession(session: BatchSession): void {
  session.files.clear()
  session.part = undefined
}

/** 必须由用户点击触发，逐包交给浏览器保存。 */
export function saveArchivePart(
  session: BatchSession,
  save: (blob: Blob, filename: string) => void = saveBlob,
): boolean {
  const part = session.part
  if (!part) return false
  save(part.blob, part.filename)
  session.part = undefined
  session.partNumber++
  return part.final
}

/** 成功文件保留在会话中，失败后重试不再重复获取；调用方负责清理会话。 */
export async function downloadMediaArchive(
  jobs: DownloadJob[],
  filename: string,
  signal: AbortSignal,
  onProgress: (message: string) => void,
  session = createBatchSession(jobs),
  onItems: (items: BatchItemStatus[]) => void = () => {},
  save: (blob: Blob, filename: string) => void = saveBlob,
): Promise<void> {
  if (session.part) return
  let received = [...session.files.values()].reduce((sum, file) => sum + file.size, 0)
  const update = (index: number, state: BatchItemStatus['state'], message: string) => {
    session.items[index] = { filename: jobs[index].filename, state, message }
    onItems(session.items.map((item) => ({ ...item })))
  }
  const preparePart = async (final: boolean) => {
    onProgress(`正在打包第 ${session.partNumber} 包…`)
    const blob = await createMediaArchive(
      new Map([...session.files].map(([name, file]) => [imageFilename(name, file.type), file])),
      signal,
    )
    signal.throwIfAborted()
    session.part = {
      blob,
      filename:
        session.partNumber === 1 && final
          ? filename
          : filename.replace(/\.zip$/i, '') + `_第${session.partNumber}包.zip`,
      number: session.partNumber,
      count: session.files.size,
      final,
    }
    for (let i = 0; i < session.nextIndex; i++) {
      if (session.files.has(jobs[i].filename))
        update(i, 'packed', `已打包到第 ${session.partNumber} 包`)
    }
    session.files.clear()
    if (session.partNumber === 1 && final) {
      saveArchivePart(session, save)
      onProgress(`已将 ${jobs.length} / ${jobs.length} 项打包，已请求浏览器保存 ZIP`)
      return
    }
    onProgress(
      `第 ${session.partNumber} 包已准备好（${session.part.count} 项），请点击保存${final ? '，这是最后一包' : '后继续下一包'}`,
    )
  }
  type Outcome = { blob: Blob; error?: never } | { blob?: never; error: unknown }
  let prefetched:
    { index: number; controller: AbortController; result: Promise<Outcome> } | undefined
  const pendingBytes = new Map<number, number>()

  async function discardPrefetch() {
    const pending = prefetched
    if (!pending) return
    prefetched = undefined
    pending.controller.abort()
    await pending.result
    pendingBytes.delete(pending.index)
    update(pending.index, 'pending', '等待获取')
  }

  async function receive(
    index: number,
    limit: number,
    taskSignal: AbortSignal,
    canPrefetch: boolean,
  ): Promise<Blob> {
    const job = jobs[index]
    const kind = job.filename.endsWith('.mp4') ? 'video' : 'image'
    let reservedLimit = limit
    update(index, 'receiving', '正在连接')
    const options = {
      signal: taskSignal,
      totalTimeoutMs: 0,
      beforeRead(total?: number) {
        // 已知小图片先预约自身字节，下一张仅使用剩余预算；未知大小与视频保持串行。
        if (
          canPrefetch &&
          kind === 'image' &&
          total &&
          Number.isSafeInteger(total) &&
          total <= limit / 2 &&
          jobs[index + 1] &&
          !jobs[index + 1].filename.endsWith('.mp4') &&
          !prefetched
        ) {
          reservedLimit = total
          const controller = new AbortController()
          const cancel = () => controller.abort(signal.reason)
          signal.addEventListener('abort', cancel, { once: true })
          const result = receive(index + 1, limit - total, controller.signal, false)
            .then(
              (blob): Outcome => ({ blob }),
              (error): Outcome => ({ error }),
            )
            .finally(() => signal.removeEventListener('abort', cancel))
          prefetched = { index: index + 1, controller, result }
        }
        return reservedLimit
      },
      onProgress(bytes: number) {
        if (taskSignal.aborted) return
        pendingBytes.set(index, bytes)
        update(index, 'receiving', `已获取 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
        const inFlight = [...pendingBytes.values()].reduce((sum, value) => sum + value, 0)
        onProgress(
          `正在获取 ${index + 1} / ${jobs.length}，累计 ${((received + inFlight) / 1024 / 1024).toFixed(1)} MB`,
        )
      },
    }
    try {
      return await fetchMediaBlob(job.url, options, kind, limit)
    } catch (error) {
      taskSignal.throwIfAborted()
      if (canPrefetch) await discardPrefetch()
      if (error instanceof MediaDownloadError && error.code === 'TOO_LARGE') throw error
      reservedLimit = limit
      pendingBytes.delete(index)
      return fetchMediaBlob(
        buildDownloadUrl(job.url, job.filename),
        {
          ...options,
          responseTimeoutMs: 30000,
          readTimeoutMs: 45000,
        },
        kind,
        limit,
      )
    }
  }

  for (let index = session.nextIndex; index < jobs.length; index++) {
    const job = jobs[index]
    signal.throwIfAborted()

    try {
      let blob: Blob
      if (prefetched?.index === index) {
        const pending = prefetched
        prefetched = undefined
        const outcome = await pending.result
        if (outcome.error !== undefined) throw outcome.error
        if (!outcome.blob) throw new MediaDownloadError('NETWORK', '下载失败，请重试')
        blob = outcome.blob
      } else {
        blob = await receive(index, session.maxPartBytes - received, signal, true)
      }
      signal.throwIfAborted()
      session.files.set(job.filename, blob)
      pendingBytes.delete(index)
      received += blob.size
      session.nextIndex = index + 1
      update(index, 'ready', '已获取')
      if (received >= session.maxPartBytes && session.nextIndex < jobs.length) {
        await preparePart(false)
        return
      }
    } catch (error) {
      await discardPrefetch()
      signal.throwIfAborted()
      if (error instanceof MediaDownloadError && error.code === 'TOO_LARGE' && session.files.size) {
        update(index, 'pending', '等待下一包')
        await preparePart(false)
        return
      }
      const reason =
        error instanceof MediaDownloadError
          ? error
          : new MediaDownloadError('NETWORK', '下载失败，请重试')
      const message = `第 ${index + 1} / ${jobs.length} 项获取失败：${reason.message}${reason.code === 'TOO_LARGE' ? `（单项上限 ${Math.round(session.maxPartBytes / 1024 / 1024)} MB，大文件请逐项下载）` : ''}`
      update(index, 'failed', reason.message)
      throw new MediaDownloadError(reason.code, message)
    }
  }
  signal.throwIfAborted()
  await preparePart(true)
}
