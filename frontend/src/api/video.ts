import type { VideoInfo } from '../types/video'
import { readVideoResponse } from './response'
import { readParseStream } from './parse-stream'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export async function parseVideo(
  input: string,
  signal?: AbortSignal,
  onPreview?: (video: VideoInfo) => void,
): Promise<VideoInfo> {
  const started = performance.now()
  let response: Response
  try {
    const form = new URLSearchParams({ url: input })
    // 分享文案通常很短；编码膨胀超过后端字节上限时保留 JSON 提交能力。
    const useJson = form.toString().length > 32 * 1024
    const accept: Record<string, string> = onPreview ? { Accept: 'application/x-ndjson' } : {}
    response = await fetch(apiBaseUrl + '/api/parse', {
      method: 'POST',
      signal,
      credentials: 'omit',
      ...(useJson
        ? {
            headers: { ...accept, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: input }),
          }
        : { headers: accept, body: form }),
    })
    // 前后端独立部署时兼容旧 Worker；只在格式不支持时回退一次。
    if (!useJson && response.status === 415) {
      signal?.throwIfAborted()
      await response.body?.cancel()
      response = await fetch(apiBaseUrl + '/api/parse', {
        method: 'POST',
        signal,
        credentials: 'omit',
        headers: { ...accept, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input }),
      })
    }
  } catch {
    signal?.throwIfAborted()
    throw new Error('网络连接失败，请检查网络后重试')
  }
  const responseMs = Math.round(performance.now() - started)
  try {
    const streaming =
      response.headers.get('Content-Type')?.split(';')[0]?.trim() === 'application/x-ndjson'
    const result = streaming
      ? await readParseStream(response, signal, onPreview)
      : await readVideoResponse(response, signal)
    if (import.meta.env.DEV) {
      // 流响应的响应头先到；总耗时到最终结果为止。不记录作品或媒体地址。
      console.debug(
        'parse_timing',
        JSON.stringify({
          durationMs: Math.round(performance.now() - started),
          responseMs,
          streaming,
          serverTiming: response.headers.get('Server-Timing'),
        }),
      )
    }
    return result
  } catch (error) {
    signal?.throwIfAborted()
    const requestId = response.headers.get('X-Request-ID')
    if (error instanceof Error && requestId && /^[0-9a-f-]{36}$/i.test(requestId)) {
      throw new Error(error.message + '（请求编号：' + requestId + '）', { cause: error })
    }
    throw error
  }
}
