import { handleRequest } from '@video-parser/backend/http'
import type { ApiRuntime } from '@video-parser/backend/runtime'

// Test-only entry, never a deployment entry. Miniflare intercepts ALL outbound
// fetches. The production Worker has separate real binding/health coverage.
const runtime: ApiRuntime = {
  version: { runtime: 'cloudflare-worker', id: 'workerd-core-fixture' },
  rateLimit: async () => ({ status: 'allowed' }),
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleRequest(request, runtime, { clientId: 'offline-fixture' })
  },
}
