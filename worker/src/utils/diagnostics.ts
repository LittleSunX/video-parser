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
}

export interface Diagnostics {
  requestId: string
  version: string
  emit(event: string, fields?: DiagnosticFields): void
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
  }
}

export function createDiagnostics(metadata?: VersionMetadata): Diagnostics {
  const requestId = crypto.randomUUID()
  const version = metadata?.id && /^[a-zA-Z0-9-]{1,64}$/.test(metadata.id) ? metadata.id : 'unknown'
  return {
    requestId,
    version,
    emit(event, fields = {}) {
      // 仅传入固定事件及计数；禁止记录请求 URL、作品信息和原始异常。
      console.info(JSON.stringify({ event, requestId, version, ...fields }))
    },
  }
}

export function withDiagnostics(response: Response, trace: Diagnostics): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Request-ID', trace.requestId)
  headers.set('X-Worker-Version', trace.version)
  const exposed = headers.get('Access-Control-Expose-Headers')
  headers.set(
    'Access-Control-Expose-Headers',
    [exposed, 'X-Request-ID', 'X-Worker-Version'].filter(Boolean).join(', '),
  )
  return new Response(response.body, { status: response.status, headers })
}
