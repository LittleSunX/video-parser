import { extractFirstUrl, readNumber } from './text'

export interface VideoStreamCandidate {
  url: string
  width: number
  height: number
  pixels: number
  bitRate: number
  fileSize: number
}

export function selectBestBitRateStream(input: unknown): VideoStreamCandidate | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined
  }

  const candidates = input
    .map(toVideoStreamCandidate)
    .filter((candidate): candidate is VideoStreamCandidate => candidate !== undefined)

  if (candidates.length === 0) {
    return undefined
  }

  candidates.sort(compareVideoStreamCandidates)

  return candidates[0]
}

export function toVideoStreamCandidate(input: unknown): VideoStreamCandidate | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }

  const entry = input as Record<string, unknown>
  const playAddr =
    entry.play_addr && typeof entry.play_addr === 'object' && !Array.isArray(entry.play_addr)
      ? (entry.play_addr as Record<string, unknown>)
      : undefined

  const url = extractFirstUrl(entry.play_addr)
  if (!url) {
    return undefined
  }

  const width = readNumber(playAddr?.width) || readNumber(entry.width)
  const height = readNumber(playAddr?.height) || readNumber(entry.height)
  const bitRate =
    readNumber(entry.bit_rate) ||
    readNumber(entry.bitRate) ||
    readNumber(playAddr?.bit_rate) ||
    readNumber(playAddr?.bitRate)

  const fileSize =
    readNumber(playAddr?.data_size) ||
    readNumber(playAddr?.file_size) ||
    readNumber(playAddr?.size) ||
    readNumber(entry.data_size) ||
    readNumber(entry.file_size) ||
    readNumber(entry.size)

  return {
    url,
    width,
    height,
    pixels: width > 0 && height > 0 ? width * height : 0,
    bitRate,
    fileSize,
  }
}

export function compareVideoStreamCandidates(
  left: VideoStreamCandidate,
  right: VideoStreamCandidate,
): number {
  // 画质优先级：
  // 1. 分辨率（总像素）
  // 2. 码率
  // 3. 文件大小
  // 三项都降序，确保同分辨率下优先选择码率和数据量更高的流。
  if (right.pixels !== left.pixels) {
    return right.pixels - left.pixels
  }

  if (right.bitRate !== left.bitRate) {
    return right.bitRate - left.bitRate
  }

  return right.fileSize - left.fileSize
}
