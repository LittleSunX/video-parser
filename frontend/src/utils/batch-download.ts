import { imageFilename } from '../../../shared/media'
import { createMediaArchive } from './media-archive'
import { fetchMediaBlob, saveBlob } from './auto-download'
import { buildDownloadUrl } from './download'
import { MediaDownloadError } from './download-error'

export interface DownloadJob {
  url: string
  filename: string
}
export const MAX_PART_BYTES = 128 * 1024 * 1024

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
export function saveArchivePart(session: BatchSession): boolean {
  const part = session.part
  if (!part) return false
  saveBlob(part.blob, part.filename)
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
    if (session.partNumber === 1 && final) {
      saveBlob(blob, filename)
      session.files.clear()
      onProgress(`已将 ${jobs.length} / ${jobs.length} 项打包，已请求浏览器保存 ZIP`)
      return
    }
    session.part = {
      blob,
      filename: filename.replace(/\.zip$/i, '') + `_第${session.partNumber}包.zip`,
      number: session.partNumber,
      count: session.files.size,
      final,
    }
    for (let i = 0; i < session.nextIndex; i++) {
      if (session.files.has(jobs[i].filename))
        update(i, 'packed', `已打包到第 ${session.partNumber} 包`)
    }
    session.files.clear()
    onProgress(
      `第 ${session.partNumber} 包已准备好（${session.part.count} 项），请点击保存${final ? '，这是最后一包' : '后继续下一包'}`,
    )
  }
  for (let index = session.nextIndex; index < jobs.length; index++) {
    const job = jobs[index]
    signal.throwIfAborted()

    try {
      update(index, 'receiving', '正在连接')
      const options = {
        signal,
        totalTimeoutMs: 0,
        onProgress: (bytes: number) => {
          update(index, 'receiving', `已获取 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
          onProgress(
            `正在获取 ${index + 1} / ${jobs.length}，累计 ${((received + bytes) / 1024 / 1024).toFixed(1)} MB`,
          )
        },
      }
      const kind = job.filename.endsWith('.mp4') ? 'video' : 'image'
      let blob: Blob
      try {
        blob = await fetchMediaBlob(job.url, options, kind, session.maxPartBytes - received)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof MediaDownloadError && error.code === 'TOO_LARGE') {
          if (session.files.size) {
            update(index, 'pending', '等待下一包')
            await preparePart(false)
            return
          }
          throw error
        }
        try {
          blob = await fetchMediaBlob(
            buildDownloadUrl(job.url, job.filename),
            options,
            kind,
            session.maxPartBytes - received,
          )
        } catch (fallbackError) {
          signal.throwIfAborted()
          if (
            fallbackError instanceof MediaDownloadError &&
            fallbackError.code === 'TOO_LARGE' &&
            session.files.size
          ) {
            update(index, 'pending', '等待下一包')
            await preparePart(false)
            return
          }
          throw fallbackError
        }
      }
      signal.throwIfAborted()
      session.files.set(job.filename, blob)
      received += blob.size
      session.nextIndex = index + 1
      update(index, 'ready', '已获取')
      if (received >= session.maxPartBytes && session.nextIndex < jobs.length) {
        await preparePart(false)
        return
      }
    } catch (error) {
      signal.throwIfAborted()
      const reason =
        error instanceof MediaDownloadError
          ? error
          : new MediaDownloadError('NETWORK', '下载失败，请重试')
      const message = `第 ${index + 1} / ${jobs.length} 项获取失败：${reason.message}${reason.code === 'TOO_LARGE' ? '（单项上限 128 MB，大文件请逐项下载）' : ''}`
      update(index, 'failed', reason.message)
      throw new MediaDownloadError(reason.code, message)
    }
  }
  signal.throwIfAborted()
  await preparePart(true)
}
