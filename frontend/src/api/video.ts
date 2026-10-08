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
  try {
    return await readVideoResponse(response, signal)
  } catch (error) {
    signal?.throwIfAborted()
    const requestId = response.headers.get('X-Request-ID')
    if (error instanceof Error && requestId && /^[0-9a-f-]{36}$/i.test(requestId)) {
      throw new Error(error.message + '（请求编号：' + requestId + '）', { cause: error })
    }
    throw error
  }
}
