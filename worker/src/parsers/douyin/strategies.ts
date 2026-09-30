import { AppError } from '../../errors/app-error'
import type { VideoInfo } from '../../types/video'
import type { ParsedMediaResult } from './types'
import { isHighConfidenceImageResult, mergeImageAssets } from './images'

interface ParseStrategy {
  name: string
  run: (signal: AbortSignal) => Promise<ParsedMediaResult>
}

/** 优先主接口；等待 600 ms 后允许一个备用策略并行，最多两个在途策略。 */
export function runParseStrategies(
  strategies: ParseStrategy[],
  signal?: AbortSignal,
): Promise<VideoInfo> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const failures: string[] = []
    let bestImage: VideoInfo | undefined
    let next = 0
    let active = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function finish(video?: VideoInfo, error?: unknown) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (video) resolve(video)
      else reject(error)
    }

    function onAbort() {
      if (signal?.reason?.name === 'TimeoutError' && bestImage) finish(bestImage)
      else finish(undefined, signal?.reason)
    }

    function schedule() {
      clearTimeout(timer)
      if (!settled && active < 2 && next < strategies.length) {
        timer = setTimeout(launch, 600)
      }
    }

    function accept(result: ParsedMediaResult) {
      const video = result.video
      if (video.videoUrl && !bestImage) {
        finish(video)
        return
      }
      if (!video.images?.length) return
      if (!bestImage) bestImage = video
      else {
        const previous = bestImage.images ?? []
        // 采用更完整列表的顺序；始终按身份补充资源，不按下标配对。
        const images =
          video.images.length > previous.length
            ? mergeImageAssets(video.images, previous)
            : mergeImageAssets(previous, video.images)
        bestImage = { ...bestImage, images }
      }
      // 完整性仍由当前策略确认；合并只补充已识别资源，不推测缺失项。
      if (
        video.images.length >= (bestImage.images?.length ?? 0) &&
        isHighConfidenceImageResult({ ...result, video: bestImage })
      )
        finish(bestImage)
    }

    function launch() {
      if (settled || active >= 2 || next >= strategies.length) return
      const strategy = strategies[next++]
      active++
      void (async () => {
        try {
          const result = await strategy.run(controller.signal)
          if (!settled) accept(result)
        } catch (error) {
          if (!settled) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(strategy.name + ': ' + message)
            console.warn('[DouyinParser] strategy failed:', strategy.name, message)
          }
        } finally {
          active--
          if (!settled) {
            if (next < strategies.length) launch()
            else if (active === 0)
              finish(
                bestImage,
                new AppError(
                  'VIDEO_RESOURCE_NOT_FOUND',
                  '视频资源解析失败：' + failures.join(' | '),
                  422,
                ),
              )
          }
        }
      })()
      schedule()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (strategies.length) launch()
    else finish(undefined, new AppError('VIDEO_RESOURCE_NOT_FOUND', '没有可用解析策略', 422))
  })
}
