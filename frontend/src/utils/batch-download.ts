import { zipSync } from 'fflate'
import { fetchMediaBlob, saveBlob } from './auto-download'
import { buildDownloadUrl } from './download'

interface DownloadJob {
  url: string
  filename: string
}
const MAX_BATCH_BYTES = 64 * 1024 * 1024

/** 单次保存完整 ZIP，避免移动浏览器拦截连续下载。 */
export async function downloadMediaArchive(
  jobs: DownloadJob[],
  filename: string,
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<void> {
  const files: Record<string, Uint8Array> = Object.create(null)
  let received = 0
  for (const [index, job] of jobs.entries()) {
    signal.throwIfAborted()
    const remaining = MAX_BATCH_BYTES - received
    if (remaining <= 0) throw new Error('批量文件超过 64 MB，请逐项下载')
    const options = {
      signal,
      onProgress: (bytes: number) => {
        onProgress(
          `正在获取 ${index + 1} / ${jobs.length}，累计 ${((received + bytes) / 1024 / 1024).toFixed(1)} MB`,
        )
      },
    }
    const kind = job.filename.endsWith('.mp4') ? 'video' : 'image'
    let blob: Blob
    try {
      try {
        blob = await fetchMediaBlob(job.url, options, kind, remaining)
      } catch {
        signal.throwIfAborted()
        blob = await fetchMediaBlob(
          buildDownloadUrl(job.url, job.filename),
          options,
          kind,
          remaining,
        )
      }
    } catch {
      signal.throwIfAborted()
      throw new Error(
        `第 ${index + 1} / ${jobs.length} 项获取失败或超出 64 MB 限制，未保存不完整压缩包；请重试或逐项下载`,
      )
    }
    signal.throwIfAborted()
    files[job.filename] = new Uint8Array(await blob.arrayBuffer())
    received += blob.size
  }
  signal.throwIfAborted()
  // 视频和图片已压缩，存储模式避免重复压缩占用手机 CPU。
  const archive = zipSync(files, { level: 0 })
  saveBlob(new Blob([new Uint8Array(archive).buffer], { type: 'application/zip' }), filename)
  onProgress(`已将 ${jobs.length} / ${jobs.length} 项打包，已请求浏览器保存 ZIP`)
}
