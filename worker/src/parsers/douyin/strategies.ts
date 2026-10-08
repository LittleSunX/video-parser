import { errorCode, mediaCounts, type Diagnostics } from '../../utils/diagnostics'
import { AppError } from '../../errors/app-error'
import type { VideoInfo } from '../../types/video'
import type { ParsedMediaResult } from './types'
import { hasAllImageResources, isHighConfidenceImageResult, mergeImageAssets } from './images'

interface ParseStrategy {
  name: string
  run: (signal: AbortSignal) => Promise<ParsedMediaResult>
}

/** 优先主接口；等待 600 ms 后允许一个备用策略并行，最多两个在途策略。 */
export function runParseStrategies(
  strategies: ParseStrategy[],
  signal?: AbortSignal,
  trace?: Diagnostics,
): Promise<VideoInfo> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const failures: string[] = []
    let bestImage: VideoInfo | undefined
    let imagesComplete = false
    let next = 0
    let active = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function finish(
      video?: VideoInfo,
      error?: unknown,
      reason: 'complete' | 'exhausted' | 'timeout' | 'cancelled' = 'complete',
    ) {
      if (settled) return
      settled = true
      trace?.emit('parse_selection', {
        reason,
        outcome: video ? 'success' : reason === 'cancelled' ? 'cancelled' : 'error',
        ...(video ? mediaCounts(video) : { code: errorCode(error) }),
      })
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
      if (video)
        resolve({
          ...video,
          ...(video.images
            ? { imagesComplete: imagesComplete && hasAllImageResources(video.images) }
            : {}),
          parseStatus: reason === 'complete' ? 'complete' : 'unverified',
          parseReason: reason === 'cancelled' ? 'exhausted' : reason,
        })
      else reject(error)
    }

    function onAbort() {
      if (signal?.reason?.name === 'TimeoutError' && bestImage)
        finish(bestImage, undefined, 'timeout')
      else
        finish(
          undefined,
          signal?.reason,
          signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
        )
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
      if (bestImage) bestImage = mergeMetadata(bestImage, video)
      if (!video.images?.length) return
      if (!bestImage) {
        bestImage = video
        imagesComplete = result.imagesComplete
      } else {
        const previous = bestImage.images ?? []
        // 采用更完整列表的顺序；始终按身份补充资源，不按下标配对。
        const images =
          video.images.length > previous.length
            ? mergeImageAssets(video.images, previous)
            : mergeImageAssets(previous, video.images)
        bestImage = { ...bestImage, images }
        // 新增资源或明确缺项时撤销确认；较短列表不能确认整个合并结果。
        if (!result.imagesComplete || images.length > previous.length) imagesComplete = false
        if (result.imagesComplete && video.images.length >= images.length) imagesComplete = true
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
      const started = Date.now()
      void (async () => {
        try {
          const result = await strategy.run(controller.signal)
          trace?.emit('strategy_complete', {
            strategy: strategy.name,
            outcome: settled ? 'cancelled' : 'success',
            durationMs: Date.now() - started,
            imagesComplete: result.imagesComplete,
            ...mediaCounts(result.video),
          })
          if (!settled) accept(result)
        } catch (error) {
          trace?.emit('strategy_complete', {
            strategy: strategy.name,
            outcome: controller.signal.aborted ? 'cancelled' : 'error',
            durationMs: Date.now() - started,
            code: errorCode(error),
          })
          if (!settled) {
            const message = errorCode(error)
            failures.push(strategy.name + ': ' + message)
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
                'exhausted',
              )
          }
        }
      })()
      schedule()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (strategies.length) launch()
    else
      finish(
        undefined,
        new AppError('VIDEO_RESOURCE_NOT_FOUND', '没有可用解析策略', 422),
        'exhausted',
      )
  })
}

function mergeMetadata(current: VideoInfo, incoming: VideoInfo): VideoInfo {
  // 音乐地址和标题作为一组补充，避免把不同接口的两首音乐配在一起。
  const musicTitle =
    !current.musicUrl && incoming.musicUrl
      ? incoming.musicTitle
      : current.musicTitle ||
        (!incoming.musicUrl || incoming.musicUrl === current.musicUrl
          ? incoming.musicTitle
          : undefined)
  return {
    ...current,
    author: current.author || incoming.author,
    cover: current.cover || incoming.cover,
    musicUrl: current.musicUrl || incoming.musicUrl,
    musicTitle,
  }
}
