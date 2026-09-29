import type { ApiResponse } from '../types/video'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Retry-After',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

export function jsonResponse<T>(
  payload: ApiResponse<T>,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(payload, {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  })
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  })
}

export function notFoundResponse(): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: '接口不存在',
      },
    },
    {
      status: 404,
      headers: CORS_HEADERS,
    },
  )
}
