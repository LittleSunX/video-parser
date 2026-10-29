import { AppError } from '../errors/app-error'
import type { ApiError, ApiResponse, VideoInfo } from '../types/video'
import { errorCode, mediaCounts, type Diagnostics } from '../utils/diagnostics'
import { errorResponse } from '../utils/error-response'
import { optionsResponse } from '../utils/response'
import { parseVideo } from './parse-service'

type ParseEvent =
  { type: 'preview' | 'result'; data: VideoInfo } | { type: 'error'; error: ApiError }

export function acceptsParseStream(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').split(',').some((value) => {
    const [type, ...parameters] = value
      .toLowerCase()
      .split(';')
      .map((part) => part.trim())
    const quality = parameters.find((parameter) => parameter.startsWith('q='))
    const q = quality === undefined ? 1 : Number(quality.slice(2))
    return type === 'application/x-ndjson' && Number.isFinite(q) && q > 0 && q <= 1
  })
}

/** One running parse feeds this response. Closing its reader cancels that same task. */
export function parseStreamResponse(
  input: string,
  clientSignal: AbortSignal,
  trace: Diagnostics,
): Response {
  const started = Date.now()
  const cancellation = new AbortController()
  const signal = AbortSignal.any([clientSignal, cancellation.signal])
  const encoder = new TextEncoder()
  let closed = false
  let output: ReadableStreamDefaultController<Uint8Array>
  let outcome: 'success' | 'error' | 'cancelled' = 'success'
  const cleanup = () => clientSignal.removeEventListener('abort', onAbort)
  const onAbort = () => {
    if (closed) return
    closed = true
    outcome = 'cancelled'
    cleanup()
    cancellation.abort()
    output.error(new AppError('REQUEST_CANCELLED', '解析已取消', 499))
  }
  const send = (event: ParseEvent) => {
    if (!closed) output.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
  }
  const close = () => {
    if (closed) return
    closed = true
    cleanup()
    output.close()
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      if (clientSignal.aborted) {
        onAbort()
        return
      }
      clientSignal.addEventListener('abort', onAbort, { once: true })
      void (async () => {
        try {
          const video = await parseVideo(input, signal, trace, (preview) => {
            // A preview never claims that quality selection is finished.
            const data = { ...preview }
            delete data.parseStatus
            delete data.parseReason
            send({ type: 'preview', data })
          })
          if (!closed) {
            trace.emit('parse_result', mediaCounts(video))
            send({ type: 'result', data: video })
            close()
          }
        } catch (error) {
          if (!closed) {
            outcome = 'error'
            trace.emit('request_error', { code: errorCode(error) })
            const response = errorResponse(error, 'parse')
            const payload = (await response.json()) as ApiResponse<never>
            if (!payload.success) send({ type: 'error', error: payload.error })
            close()
          }
        } finally {
          cleanup()
          trace.emit('parse_stream_complete', {
            operation: 'parse',
            outcome,
            durationMs: Math.max(0, Date.now() - started),
          })
        }
      })()
    },
    cancel() {
      if (closed) return
      closed = true
      outcome = 'cancelled'
      cleanup()
      cancellation.abort()
    },
  })
  const headers = new Headers(optionsResponse().headers)
  headers.set('Content-Type', 'application/x-ndjson; charset=utf-8')
  headers.set('Cache-Control', 'no-store, no-transform')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(body, { headers })
}
