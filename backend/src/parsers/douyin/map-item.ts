import { isSafeHttpUrl } from '../../../../shared/video-contract'
import { AppError } from '../../errors/app-error'
import type { VideoInfo } from '../../types/video'
import type { DouyinItem, ParsedMediaResult } from './types'
import { normalizeAwemeId } from './items'
import { extractImageAssetsWithCompleteness } from './images'
import { selectBestBitRateStream, toVideoStreamCandidate } from './streams'
import { extractFirstUrl, normalizeUrl, normalizeText, readNumber, toPlayableUrl } from './text'

function optionalHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = normalizeUrl(value).trim()
  return isSafeHttpUrl(normalized) ? normalized : undefined
}

export function mapItemToVideoInfo(
  item: DouyinItem,
  sourceUrl: URL,
  fallbackVideoId: string,
): ParsedMediaResult {
  const itemId = normalizeAwemeId(item.aweme_id)

  if (itemId && itemId !== fallbackVideoId) {
    throw new AppError('VIDEO_ID_MISMATCH', '解析结果作品 ID 与目标作品不一致', 422)
  }

  const rawImages = [
    ...(item.image_post_info?.images ?? []),
    ...(item.image_post_info?.image_list ?? []),
    ...(item.images ?? []),
    ...(item.image_list ?? []),
  ]
  const { images: imageAssets, imagesComplete } = extractImageAssetsWithCompleteness(rawImages)
  const video = item.video ?? {}
  const author = item.author?.nickname ? normalizeText(item.author.nickname) : ''
  const musicUrl = optionalHttpUrl(extractFirstUrl(item.music?.play_url))
  const musicTitle = item.music?.title ? normalizeText(item.music.title) : ''
  const cover = optionalHttpUrl(
    (imageAssets[0]?.url || undefined) ??
      extractFirstUrl(video.origin_cover) ??
      extractFirstUrl(video.cover) ??
      extractFirstUrl(video.dynamic_cover),
  )

  if (imageAssets.length > 0) {
    const result: VideoInfo = {
      platform: 'douyin',
      mediaType: 'image',
      videoId: itemId ?? fallbackVideoId,
      sourceUrl: sourceUrl.toString(),
      title: normalizeText(item.desc || '抖音图文'),
      ...(author ? { author } : {}),
      ...(cover ? { cover } : {}),
      images: imageAssets,
      ...(musicUrl ? { musicUrl } : {}),
      ...(musicTitle ? { musicTitle } : {}),
    }
    return { video: result, imagesComplete }
  }

  const bestBitRateStream = selectBestBitRateStream(video.bit_rate)

  // 视频作品优先选择 bit_rate 中的最高画质流；没有候选时再回退到默认 play_addr。
  const selectedStream =
    bestBitRateStream ??
    [video.play_addr, video.play_addr_h264, video.download_addr]
      .map((play_addr) => toVideoStreamCandidate({ play_addr }))
      .find((candidate) => candidate !== undefined)
  const rawVideoUrl = selectedStream?.url ? normalizeUrl(selectedStream.url).trim() : ''
  const playableUrl = rawVideoUrl ? toPlayableUrl(rawVideoUrl) : ''

  if (!isSafeHttpUrl(playableUrl)) {
    throw new AppError(
      'VIDEO_RESOURCE_NOT_FOUND',
      '已获取作品信息，但没有找到视频播放地址或图文资源',
      422,
    )
  }

  // Alternatives must stay paired with this exact selected stream and its file size.
  const videoUrlAlternatives =
    playableUrl === rawVideoUrl ? selectedStream?.urlAlternatives : undefined
  // 仅使用所选码率流的大小；变换播放地址后不沿用原文件大小。
  const videoSize =
    bestBitRateStream &&
    playableUrl === normalizeUrl(bestBitRateStream.url).trim() &&
    Number.isSafeInteger(bestBitRateStream.fileSize) &&
    bestBitRateStream.fileSize > 0
      ? bestBitRateStream.fileSize
      : undefined
  const duration = readNumber(item.duration) || readNumber(video.duration)

  return {
    imagesComplete: true,
    video: {
      platform: 'douyin',
      mediaType: 'video',
      videoId: itemId ?? fallbackVideoId,
      sourceUrl: sourceUrl.toString(),
      title: normalizeText(item.desc || '抖音视频'),
      ...(author ? { author } : {}),
      ...(cover ? { cover } : {}),
      ...(duration ? { duration } : {}),
      videoUrl: playableUrl,
      ...(videoUrlAlternatives?.length ? { videoUrlAlternatives } : {}),
      ...(videoSize === undefined ? {} : { videoSize }),
      ...(musicUrl ? { musicUrl } : {}),
      ...(musicTitle ? { musicTitle } : {}),
    },
  }
}
