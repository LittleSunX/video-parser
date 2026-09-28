import type { VideoInfo } from '../types/video'

export interface VideoParser {
  supports(url: string): boolean
  parse(url: string, signal?: AbortSignal): Promise<VideoInfo>
}
