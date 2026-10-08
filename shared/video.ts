export type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'tiktok' | 'unknown'
export type MediaType = 'video' | 'image'

export interface ImageAsset {
  url: string
  livePhotoUrl?: string
  watermarkFree?: boolean
}

export interface VideoInfo {
  platform: Platform
  mediaType: MediaType
  videoId: string
  sourceUrl: string
  title: string
  author?: string
  cover?: string
  /** 时长，单位为毫秒。 */
  duration?: number
  videoUrl?: string
  images?: ImageAsset[]
  musicUrl?: string
  musicTitle?: string
  /** 图文来源列出的图片及已声明实况资源是否已获取；与无水印状态独立。 */
  imagesComplete?: boolean
  /** complete 表示满足现有策略条件，不是对上游资源完整性的独立证明。 */
  parseStatus?: 'complete' | 'unverified'
  parseReason?: 'complete' | 'exhausted' | 'timeout'
}

export interface ApiError {
  code: string
  message: string
}

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: ApiError }
