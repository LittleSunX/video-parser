import type { ApiVersion } from '@video-parser/backend/runtime'
import { createDiagnostics, withDiagnostics } from '../../backend/src/utils/diagnostics'
import { downloadErrorPage } from '../../backend/src/utils/download-error-page'

/** Adapter errors use the same diagnostics and native-download protocol as the core. */
export async function publicError(
  version: ApiVersion,
  status: number,
  code: string,
  message: string,
  request?: Request,
): Promise<Response> {
  const trace = createDiagnostics(version)
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Cache-Control': 'no-store',
  })
  if (status === 503) headers.set('Retry-After', '1')
  let response = Response.json({ success: false, error: { code, message } }, { status, headers })
  if (request?.method === 'GET') {
    const url = new URL(request.url)
    const token = url.searchParams.get('errorToken') ?? ''
    if (
      url.pathname === '/api/download' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    ) {
      response = await downloadErrorPage(response, token, trace)
    }
  }
  return withDiagnostics(response, trace)
}
