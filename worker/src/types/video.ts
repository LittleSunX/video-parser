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
}

export interface ApiError {
  code: string
  message: string
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError }
