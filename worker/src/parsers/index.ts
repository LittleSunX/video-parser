import type { VideoParser } from './base'
import { DouyinParser } from './douyin'

const parsers: VideoParser[] = [new DouyinParser()]

export function findParser(url: string): VideoParser | undefined {
  return parsers.find((parser) => parser.supports(url))
}
