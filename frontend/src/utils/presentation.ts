import type { VideoInfo } from '../types/video'
import { imageDownloadTargets } from '../composables/useMediaDownloads'

/** 只拆出明确的标签；保留标题正文及标签之后的普通文字。 */
export function presentTitle(title: string) {
  const tags = [...new Set(title.match(/#[^\s#]+/gu) ?? [])]
  const text = title
    .replace(/#[^\s#]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return { text: text || (tags.length ? '分享的作品' : '未命名作品'), tags }
}

export function imageSaveSummary(video: VideoInfo | null, preferLive: boolean) {
  const targets = imageDownloadTargets(video, preferLive)
  const live = targets.filter((target) => target.live).length
  const stills = targets.length - live
  return [
    stills ? `${stills} 张${preferLive ? '图片' : '高清原图'}` : '',
    live ? `${live} 段动态视频` : '',
  ]
    .filter(Boolean)
    .join(' + ')
}
