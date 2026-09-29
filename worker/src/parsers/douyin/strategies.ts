import { AppError } from '../../errors/app-error'
import type { VideoInfo } from '../../types/video'
import type { ParsedMediaResult } from './types'
import { isHighConfidenceImageResult, scoreImageResult } from './images'

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
    let bestScore = -1
    let knownImageCount = 0
    let knownLiveCount = 0
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
      knownImageCount = Math.max(knownImageCount, video.images.length)
      knownLiveCount = Math.max(
        knownLiveCount,
        video.images.filter((image) => image.livePhotoUrl).length,
      )
      const score = scoreImageResult(video)
      const bestCount = bestImage?.images?.length ?? 0
      // 先保留更多资源；数量相同时再比较动态轨和图片质量。
      if (
        video.images.length > bestCount ||
        (video.images.length === bestCount && score > bestScore)
      ) {
        bestImage = video
        bestScore = score
      }
      // 不因另一份结果图片无水印就提前放弃已发现的动态轨或更多图片。
      const keepsKnownResources =
        video.images.length >= knownImageCount &&
        video.images.filter((image) => image.livePhotoUrl).length >= knownLiveCount
      if (isHighConfidenceImageResult(result) && bestImage === video && keepsKnownResources)
        finish(video)
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
