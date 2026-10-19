import type { VideoInfo } from '../types/video'
import { readVideoResponse } from './response'
import { readParseStream } from './parse-stream'
import { createParseDiagnostics, ParseError, type ParseStage } from './parse-error'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export async function parseVideo(
  input: string,
  signal?: AbortSignal,
  onPreview?: (video: VideoInfo) => void,
): Promise<VideoInfo> {
  const started = performance.now()
  let response: Response | undefined
  let responseMs: number | undefined
  let firstPreviewMs: number | undefined
  let streaming: boolean | undefined
  let stage: ParseStage = 'request'
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
      // 清理不能阻塞兼容请求，最终报告只关联真正使用的响应。
      void response.body?.cancel().catch(() => {})
      response = undefined
      response = await fetch(apiBaseUrl + '/api/parse', {
        method: 'POST',
        signal,
        credentials: 'omit',
        headers: { ...accept, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input }),
      })
    }
    responseMs = Math.round(performance.now() - started)
    stage = 'response'
    streaming =
      response.headers.get('Content-Type')?.split(';')[0]?.trim() === 'application/x-ndjson'
    const result = streaming
      ? await readParseStream(response, signal, (candidate) => {
          firstPreviewMs ??= Math.round(performance.now() - started)
          stage = 'preview'
          onPreview?.(candidate)
        })
      : await readVideoResponse(response, signal)
    signal?.throwIfAborted()
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
    const timedOut = signal?.aborted && signal.reason?.name === 'TimeoutError'
    if (signal?.aborted && !timedOut) signal.throwIfAborted()
    const code = timedOut
      ? 'CLIENT_TIMEOUT'
      : error instanceof ParseError
        ? error.code
        : stage === 'request'
          ? 'NETWORK_ERROR'
          : 'INVALID_RESPONSE'
    const diagnostics = createParseDiagnostics({
      code,
      stage,
      durationMs: performance.now() - started,
      responseMs,
      firstPreviewMs,
      streaming,
      status: response?.status,
      requestId: response?.headers.get('X-Request-ID') ?? undefined,
      workerVersion: response?.headers.get('X-Worker-Version') ?? undefined,
      frontendCommit: import.meta.env.VITE_APP_COMMIT,
    })
    const message = timedOut
      ? '解析超时，请重试'
      : stage === 'request'
        ? '网络连接失败，请检查网络后重试'
        : error instanceof Error
          ? error.message
          : '作品解析失败，请稍后重试'
    throw new ParseError(
      code,
      diagnostics.requestId ? message + '（请求编号：' + diagnostics.requestId + '）' : message,
      diagnostics,
    )
  }
}
