import type { VideoInfo } from '../types/video'
import { readVideoResponse } from './response'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export async function parseVideo(input: string, signal?: AbortSignal): Promise<VideoInfo> {
  let response: Response
  try {
    response = await fetch(apiBaseUrl + '/api/parse', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input }),
    })
  } catch {
    signal?.throwIfAborted()
    throw new Error('网络连接失败，请检查网络后重试')
  }
  return readVideoResponse(response, signal)
}
