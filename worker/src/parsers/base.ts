import type { Diagnostics } from '../utils/diagnostics'
import type { VideoInfo } from '../types/video'

export interface VideoParser {
  supports(url: string): boolean
  parse(
    url: string,
    signal?: AbortSignal,
    trace?: Diagnostics,
    onPreview?: (video: VideoInfo) => void,
  ): Promise<VideoInfo>
}
