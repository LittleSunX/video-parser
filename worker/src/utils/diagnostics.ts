import { AppError } from '../errors/app-error'
import type { VideoInfo } from '../types/video'

export interface VersionMetadata {
  id: string
  tag?: string
  timestamp?: string
}

interface DiagnosticFields {
  operation?: 'parse' | 'download' | 'other'
  durationMs?: number
  status?: number
  strategy?: string
  outcome?: 'success' | 'error' | 'cancelled'
  reason?: 'complete' | 'exhausted' | 'timeout' | 'cancelled'
  code?: string
  images?: number
  livePhotos?: number
  videos?: number
  imagesComplete?: boolean
  endpoint?: UpstreamEndpoint
  attempt?: number
  result?: UpstreamResult
  waitMs?: number
  readMs?: number
  extractMs?: number
  sinceRequestMs?: number
  watermarkFreeImages?: number
  hasAuthor?: boolean
  hasCover?: boolean
  hasMusic?: boolean
}

export type UpstreamStrategy = 'web-detail' | 'mobile-feed' | 'mobile-ssr' | 'page-meta'
export type UpstreamEndpoint =
  | 'web-detail'
  | 'feed-amemv-6383'
  | 'feed-amemv-1128'
  | 'feed-snssdk-6383'
  | 'feed-snssdk-1128'
  | 'source-page'
  | 'share-video'
  | 'share-video-app'
  | 'share-video-ssr'
  | 'share-note'
  | 'share-slides'
  | 'mobile-note'
  | 'current-page'
export type UpstreamResult =
  | 'success'
  | 'http_error'
  | 'empty_response'
  | 'invalid_json'
  | 'item_missing'
  | 'page_too_small'
  | 'router_data_missing'
  | 'page_mismatch'
  | 'resource_missing'
  | 'timeout'
  | 'cancelled'
  | 'network_error'
  | 'read_error'
  | 'extract_error'

const DIAGNOSTIC_EVENTS = new Set([
  'request_response',
  'request_error',
  'parse_result',
  'resolve_complete',
  'strategy_complete',
  'parse_selection',
  'parse_first_usable',
  'upstream_attempt',
])
const UPSTREAM_STRATEGIES = new Set(['web-detail', 'mobile-feed', 'mobile-ssr', 'page-meta'])
const UPSTREAM_ENDPOINTS = new Set([
  'web-detail',
  'feed-amemv-6383',
  'feed-amemv-1128',
  'feed-snssdk-6383',
  'feed-snssdk-1128',
  'source-page',
  'share-video',
  'share-video-app',
  'share-video-ssr',
  'share-note',
  'share-slides',
  'mobile-note',
  'current-page',
])
const UPSTREAM_RESULTS = new Set([
  'success',
  'http_error',
  'empty_response',
  'invalid_json',
  'item_missing',
  'page_too_small',
  'router_data_missing',
  'page_mismatch',
  'resource_missing',
  'timeout',
  'cancelled',
  'network_error',
  'read_error',
  'extract_error',
])

export interface Diagnostics {
  requestId: string
  version: string
  emit(event: string, fields?: DiagnosticFields): void
  serverTiming?(): string
}

export function errorCode(error: unknown): string {
  if (error instanceof AppError && /^[A-Z_]{1,64}$/.test(error.code)) return error.code
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT'
  if (error instanceof Error && error.name === 'AbortError') return 'CANCELLED'
  return 'UNEXPECTED_ERROR'
}

export function mediaCounts(video: VideoInfo) {
  return {
    images: video.images?.filter((image) => !!image.url).length ?? 0,
    livePhotos: video.images?.filter((image) => !!image.livePhotoUrl).length ?? 0,
    videos: video.videoUrl ? 1 : 0,
    watermarkFreeImages:
      video.images?.filter((image) => !!image.url && image.watermarkFree).length ?? 0,
    hasAuthor: !!video.author,
    hasCover: !!video.cover,
    hasMusic: !!video.musicUrl,
  }
}

/** One diagnostic record per existing fetch; labels and outcomes never contain upstream data. */
export function createUpstreamAttempt(
  trace: Diagnostics | undefined,
  strategy: UpstreamStrategy,
  endpoint: UpstreamEndpoint,
  attempt: number,
  signal?: AbortSignal,
) {
  const started = Date.now()
  const timings = { waitMs: 0, readMs: 0, extractMs: 0 }
  let phase: 'waitMs' | 'readMs' | 'extractMs' = 'waitMs'
  let status: number | undefined
  let result: UpstreamResult | undefined
  let finished = false
  async function measure<T>(name: 'waitMs' | 'readMs', operation: () => Promise<T>): Promise<T> {
    phase = name
    const begin = Date.now()
    try {
      return await operation()
    } finally {
      timings[name] += Math.max(0, Date.now() - begin)
    }
  }
  return {
    async response(operation: () => Promise<Response>) {
      const response = await measure('waitMs', operation)
      status = response.status
      return response
    },
    read<T>(operation: () => Promise<T>): Promise<T> {
      return measure('readMs', operation)
    },
    extract<T>(operation: () => T): T {
      phase = 'extractMs'
      const begin = Date.now()
      try {
        return operation()
      } finally {
        timings.extractMs += Math.max(0, Date.now() - begin)
      }
    },
    result(value: UpstreamResult) {
      result = value
    },
    fail(error: unknown) {
      const reason = signal?.aborted ? signal.reason : error
      if (reason instanceof Error && reason.name === 'TimeoutError') result = 'timeout'
      else if (signal?.aborted || (reason instanceof Error && reason.name === 'AbortError'))
        result = 'cancelled'
      else if (!result) {
        if (reason instanceof SyntaxError) result = 'invalid_json'
        else if (reason instanceof AppError && reason.code === 'VIDEO_RESOURCE_NOT_FOUND')
          result = 'resource_missing'
        else
          result =
            phase === 'waitMs'
              ? 'network_error'
              : phase === 'readMs'
                ? 'read_error'
                : 'extract_error'
      }
    },
    finish() {
      if (finished) return
      finished = true
      trace?.emit('upstream_attempt', {
        strategy,
        endpoint,
        attempt,
        ...(status === undefined ? {} : { status }),
        result: result ?? 'extract_error',
        ...timings,
        durationMs: Math.max(0, Date.now() - started),
      })
    },
  }
}

function safeFields(fields: DiagnosticFields): DiagnosticFields {
  const safe: DiagnosticFields = {}
  for (const name of [
    'durationMs',
    'waitMs',
    'readMs',
    'extractMs',
    'sinceRequestMs',
    'attempt',
    'status',
    'images',
    'livePhotos',
    'videos',
    'watermarkFreeImages',
  ] as const) {
    const value = fields[name]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[name] = value
  }
  for (const name of ['imagesComplete', 'hasAuthor', 'hasCover', 'hasMusic'] as const)
    if (typeof fields[name] === 'boolean') safe[name] = fields[name]
  if (fields.operation && ['parse', 'download', 'other'].includes(fields.operation))
    safe.operation = fields.operation
  if (fields.strategy && UPSTREAM_STRATEGIES.has(fields.strategy)) safe.strategy = fields.strategy
  if (fields.endpoint && UPSTREAM_ENDPOINTS.has(fields.endpoint)) safe.endpoint = fields.endpoint
  if (fields.result && UPSTREAM_RESULTS.has(fields.result)) safe.result = fields.result
  if (fields.outcome && ['success', 'error', 'cancelled'].includes(fields.outcome))
    safe.outcome = fields.outcome
  if (fields.reason && ['complete', 'exhausted', 'timeout', 'cancelled'].includes(fields.reason))
    safe.reason = fields.reason
  if (typeof fields.code === 'string' && /^[A-Z_]{1,64}$/.test(fields.code)) safe.code = fields.code
  return safe
}

export function createDiagnostics(metadata?: VersionMetadata): Diagnostics {
  const started = Date.now()
  const requestId = crypto.randomUUID()
  const version =
    typeof metadata?.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(metadata.id)
      ? metadata.id
      : 'unknown'
  const timings = new Map<string, number>()
  return {
    requestId,
    version,
    emit(event, fields = {}) {
      event = DIAGNOSTIC_EVENTS.has(event) ? event : 'unknown_event'
      fields = safeFields(fields)
      // Selection durations start at the strategy runner; this includes input/resolve time too.
      if (event === 'parse_first_usable' || event === 'parse_selection')
        fields.sinceRequestMs = Math.max(0, Date.now() - started)
      const metric =
        event === 'request_response'
          ? 'worker'
          : event === 'resolve_complete'
            ? 'resolve'
            : event === 'strategy_complete' && fields.strategy === 'web-detail'
              ? 'primary'
              : undefined
      if (
        metric &&
        typeof fields.durationMs === 'number' &&
        Number.isFinite(fields.durationMs) &&
        fields.durationMs >= 0
      ) {
        timings.set(metric, fields.durationMs)
      }
      // 仅传入固定事件及计数；禁止记录请求 URL、作品信息和原始异常。
      console.info(JSON.stringify({ event, requestId, version, ...fields }))
    },
    serverTiming() {
      return [...timings].map(([name, duration]) => name + ';dur=' + duration).join(', ')
    },
  }
}

export function withDiagnostics(response: Response, trace: Diagnostics): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Request-ID', trace.requestId)
  headers.set('X-Worker-Version', trace.version)
  const timing = trace.serverTiming?.()
  if (timing) headers.set('Server-Timing', timing)
  const exposed = headers.get('Access-Control-Expose-Headers')
  headers.set(
    'Access-Control-Expose-Headers',
    [exposed, 'X-Request-ID', 'X-Worker-Version', timing ? 'Server-Timing' : undefined]
      .filter(Boolean)
      .join(', '),
  )
  return new Response(response.body, { status: response.status, headers })
}
