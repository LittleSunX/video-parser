export type ParseStage = 'request' | 'response' | 'preview'

/** 仅含定位问题所需的固定字段，不含分享文案、媒体地址或异常原文。 */
export interface ParseDiagnostics {
  schemaVersion: 1
  code: string
  stage: ParseStage
  durationMs: number
  responseMs?: number
  firstPreviewMs?: number
  streaming?: boolean
  status?: number
  requestId?: string
  workerVersion?: string
  frontendCommit?: string
}

const PUBLIC_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_URL',
  'INPUT_TOO_LARGE',
  'INVALID_CONTENT_TYPE',
  'UNSUPPORTED_PLATFORM',
  'URL_RESOLVE_FAILED',
  'VIDEO_NOT_FOUND',
  'VIDEO_ID_MISMATCH',
  'VIDEO_RESOURCE_NOT_FOUND',
  'PARSE_FAILED',
  'PARSE_TIMEOUT',
  'REQUEST_FAILED',
  'REQUEST_CANCELLED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'UPSTREAM_BUSY',
  'NETWORK_ERROR',
  'CLIENT_TIMEOUT',
  'INVALID_RESPONSE',
  'HTTP_ERROR',
  'UNKNOWN_ERROR',
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseErrorCode(value: unknown): string {
  return typeof value === 'string' && PUBLIC_CODES.has(value) ? value : 'UNKNOWN_ERROR'
}

function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(86400000, Math.round(value))
    : undefined
}

export function createParseDiagnostics(fields: Partial<ParseDiagnostics>): ParseDiagnostics {
  const report: ParseDiagnostics = {
    schemaVersion: 1,
    code: parseErrorCode(fields.code),
    stage: fields.stage === 'response' || fields.stage === 'preview' ? fields.stage : 'request',
    durationMs: milliseconds(fields.durationMs) ?? 0,
  }
  const responseMs = milliseconds(fields.responseMs)
  const firstPreviewMs = milliseconds(fields.firstPreviewMs)
  if (responseMs !== undefined) report.responseMs = responseMs
  if (firstPreviewMs !== undefined) report.firstPreviewMs = firstPreviewMs
  if (typeof fields.streaming === 'boolean') report.streaming = fields.streaming
  if (
    typeof fields.status === 'number' &&
    Number.isInteger(fields.status) &&
    fields.status >= 100 &&
    fields.status <= 599
  )
    report.status = fields.status
  if (typeof fields.requestId === 'string' && UUID.test(fields.requestId))
    report.requestId = fields.requestId
  if (
    typeof fields.workerVersion === 'string' &&
    (UUID.test(fields.workerVersion) || fields.workerVersion === 'unknown')
  )
    report.workerVersion = fields.workerVersion
  if (typeof fields.frontendCommit === 'string' && /^[a-f0-9]{40}$/i.test(fields.frontendCommit))
    report.frontendCommit = fields.frontendCommit
  return report
}

export function serializeParseDiagnostics(report: ParseDiagnostics): string {
  // 再次白名单构造，调用方意外附加的字段也不会进入剪贴板。
  return JSON.stringify(createParseDiagnostics(report), null, 2)
}

export class ParseError extends Error {
  readonly code: string
  readonly diagnostics?: ParseDiagnostics

  constructor(code: unknown, message: string, diagnostics?: ParseDiagnostics) {
    super(message)
    this.name = 'ParseError'
    this.code = parseErrorCode(code)
    if (diagnostics) this.diagnostics = createParseDiagnostics(diagnostics)
  }
}
