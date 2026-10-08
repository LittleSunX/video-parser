import type { VideoInfo } from '../types/video'
import { readVideoResponse } from './response'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export async function parseVideo(input: string, signal?: AbortSignal): Promise<VideoInfo> {
  const started = performance.now()
  let response: Response
  try {
    const form = new URLSearchParams({ url: input })
    // 分享文案通常很短；编码膨胀超过后端字节上限时保留 JSON 提交能力。
    const useJson = form.toString().length > 32 * 1024
    response = await fetch(apiBaseUrl + '/api/parse', {
      method: 'POST',
      signal,
      credentials: 'omit',
      ...(useJson
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input }) }
        : { body: form }),
    })
    // 前后端独立部署时兼容旧 Worker；只在格式不支持时回退一次。
    if (!useJson && response.status === 415) {
      signal?.throwIfAborted()
      await response.body?.cancel()
      response = await fetch(apiBaseUrl + '/api/parse', {
        method: 'POST',
        signal,
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input }),
      })
    }
  } catch {
    signal?.throwIfAborted()
    throw new Error('网络连接失败，请检查网络后重试')
  }
  if (import.meta.env.DEV) {
    // 只输出耗时与固定服务端指标，不记录分享文案或媒体地址。
    console.debug(
      'parse_timing',
      JSON.stringify({
        durationMs: Math.round(performance.now() - started),
        serverTiming: response.headers.get('Server-Timing'),
      }),
    )
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
