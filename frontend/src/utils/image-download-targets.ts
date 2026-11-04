import type { VideoInfo } from '../types/video'

export function imageDownloadTargets(video: VideoInfo | null, preferLive: boolean) {
  return (video?.images ?? []).flatMap((asset, index) => {
    const live = preferLive && !!asset.livePhotoUrl
    const url = live ? asset.livePhotoUrl : asset.url
    return url ? [{ index, url, live, watermarkFree: !!asset.watermarkFree }] : []
  })
}

export function imageDownloadLabel(targets: ReturnType<typeof imageDownloadTargets>) {
  if (!targets.length) return ''
  if (targets.length === 1) {
    const target = targets[0]!
    return target.live ? '下载动态视频' : target.watermarkFree ? '下载无水印原图' : '下载高清原图'
  }
  return targets.some((target) => target.live)
    ? '打包下载全部（动态优先）'
    : targets.every((target) => target.watermarkFree)
      ? '打包下载全部无水印原图'
      : '打包下载全部高清原图'
}
