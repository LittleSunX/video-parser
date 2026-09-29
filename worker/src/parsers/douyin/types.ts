import type { VideoInfo } from '../../types/video'

export interface DouyinItem {
  aweme_id?: string
  desc?: string
  duration?: number
  author?: {
    nickname?: string
  }
  video?: {
    duration?: number
    bit_rate?: unknown
    play_addr?: unknown
    play_addr_h264?: unknown
    download_addr?: unknown
    cover?: unknown
    origin_cover?: unknown
    dynamic_cover?: unknown
  }
  images?: unknown[]
  image_list?: unknown[]
  image_post_info?: {
    images?: unknown[]
    image_list?: unknown[]
  }
  music?: {
    title?: string
    play_url?: unknown
  }
}

/** 内部策略结果，完整性元数据不会进入 API 响应。 */
export interface ParsedMediaResult {
  video: VideoInfo
  imagesComplete: boolean
}
