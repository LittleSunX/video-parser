import { handleRequest } from '@video-parser/backend/http'
import { createCloudflareRuntime, type Env } from './cloudflare-runtime'

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // Cloudflare sets this header at the edge. Never use the public X-Forwarded-For header.
    const clientId = request.headers.get('CF-Connecting-IP') || 'unknown'
    return handleRequest(request, createCloudflareRuntime(env), { clientId })
  },
}
