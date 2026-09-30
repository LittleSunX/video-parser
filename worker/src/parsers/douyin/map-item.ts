import { AppError } from '../../errors/app-error'
import type { VideoInfo } from '../../types/video'
import type { DouyinItem, ParsedMediaResult } from './types'
import { normalizeAwemeId } from './items'
import { extractImageAssets, selectBestImageUrl, extractLivePhotoUrl } from './images'
import { selectBestBitRateStream } from './streams'
import { extractFirstUrl, normalizeUrl, normalizeText, readNumber, toPlayableUrl } from './text'

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
  const imageAssets = extractImageAssets(rawImages)
  const video = item.video ?? {}
  const musicUrl = extractFirstUrl(item.music?.play_url)
  const cover =
    (imageAssets[0]?.url || undefined) ??
    extractFirstUrl(video.origin_cover) ??
    extractFirstUrl(video.cover) ??
    extractFirstUrl(video.dynamic_cover)

  if (imageAssets.length > 0) {
    const result: VideoInfo = {
      platform: 'douyin',
      mediaType: 'image',
      videoId: itemId ?? fallbackVideoId,
      sourceUrl: sourceUrl.toString(),
      title: normalizeText(item.desc || '抖音图文'),
      author: item.author?.nickname ? normalizeText(item.author.nickname) : undefined,
      cover: cover ? normalizeUrl(cover) : undefined,
      images: imageAssets,
      musicUrl: musicUrl ? normalizeUrl(musicUrl) : undefined,
      musicTitle: item.music?.title ? normalizeText(item.music.title) : undefined,
    }
    const incompleteImages = rawImages.some((image) => {
      if (!image || typeof image !== 'object' || Array.isArray(image)) return true
      const value = image as Record<string, unknown>
      const liveUrl = extractLivePhotoUrl(value)
      if (!selectBestImageUrl(value)?.url) return true
      return !!(value.video || value.video_play_addr || value.video_download_addr) && !liveUrl
    })
    return { video: result, imagesComplete: !incompleteImages }
  }

  const bestBitRateStream = selectBestBitRateStream(video.bit_rate)

  // 视频作品优先选择 bit_rate 中的最高画质流；没有候选时再回退到默认 play_addr。
  const videoUrl =
    bestBitRateStream?.url ??
    extractFirstUrl(video.play_addr) ??
    extractFirstUrl(video.play_addr_h264) ??
    extractFirstUrl(video.download_addr)

  if (!videoUrl) {
    throw new AppError(
      'VIDEO_RESOURCE_NOT_FOUND',
      '已获取作品信息，但没有找到视频播放地址或图文资源',
      422,
    )
  }

  if (bestBitRateStream) {
    console.info(
      '[DouyinParser] selected highest quality stream:',
      bestBitRateStream.width + 'x' + bestBitRateStream.height,
      'bitRate=' + bestBitRateStream.bitRate,
      'fileSize=' + bestBitRateStream.fileSize,
    )
  }

  return {
    imagesComplete: true,
    video: {
      platform: 'douyin',
      mediaType: 'video',
      videoId: itemId ?? fallbackVideoId,
      sourceUrl: sourceUrl.toString(),
      title: normalizeText(item.desc || '抖音视频'),
      author: item.author?.nickname ? normalizeText(item.author.nickname) : undefined,
      cover: cover ? normalizeUrl(cover) : undefined,
      duration: readNumber(item.duration) || readNumber(video.duration) || undefined,
      videoUrl: toPlayableUrl(normalizeUrl(videoUrl)),
      musicUrl: musicUrl ? normalizeUrl(musicUrl) : undefined,
      musicTitle: item.music?.title ? normalizeText(item.music.title) : undefined,
    },
  }
}
