import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { getRequestListener } from '@hono/node-server'
import type { ApiRequestContext, ApiRuntime, ApiVersion } from '@video-parser/backend/runtime'
import { readConfig, type ServerConfig } from './config'
import { clientIdentity } from './client-ip'
import { createRateLimiter } from './rate-limit'
import { publicError } from './responses'

export type ApiHandler = (
  request: Request,
  runtime: ApiRuntime,
  context: ApiRequestContext,
) => Promise<Response>
export interface ApiServerOptions {
  handler: ApiHandler
  version: ApiVersion
  config?: ServerConfig
  logger?: (event: string) => void
}

/** Hono's default stream-error path logs/appends raw errors. Never feed it an upstream rejection. */
function protectResponseStream(
  response: Response,
  outgoing: { destroy(): unknown },
  logger?: (event: string) => void,
): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  let ended = false
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (ended) return
          if (done) {
            ended = true
            reader.releaseLock()
            controller.close()
          } else controller.enqueue(value)
        } catch {
          if (ended) return
          ended = true
          reader.releaseLock()
          // Destroy first: a truncated body must not become a successful end-of-stream.
          outgoing.destroy()
          controller.close()
          logger?.('response_stream_failed')
        }
      },
      async cancel() {
        if (ended) return
        ended = true
        try {
          await reader.cancel()
        } catch {
          /* No upstream exception may reach adapter logging. */
        } finally {
          reader.releaseLock()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(body, { status: response.status, headers: response.headers })
}

/** Does not listen or install process signal handlers on import/construction. */
export function createApiServer(options: ApiServerOptions) {
  const config = options.config ?? readConfig()
  const limiter = createRateLimiter()
  const runtime: ApiRuntime = { version: options.version, rateLimit: limiter.limit }
  const counts = { parse: 0, download: 0 }
  const downloadsByIp = new Map<string, number>()
  const active = new Set<AbortController>()
  const sockets = new Set<Socket>()
  let stopping = false
  let shutdownPromise: Promise<void> | undefined
  const listener = getRequestListener(
    async (request, { incoming, outgoing }) => {
      const failure = (status: number, code: string, message: string) =>
        publicError(runtime.version, status, code, message, request)
      if (stopping) {
        outgoing.setHeader('Connection', 'close')
        return failure(503, 'SERVER_BUSY', 'Server shutting down')
      }
      const controller = new AbortController()
      // Keep Hono's body adapter and connection signal, adding our shutdown deadline.
      Object.defineProperty(request, 'signal', {
        value: AbortSignal.any([request.signal, controller.signal]),
      })
      active.add(controller)
      const socket = incoming.socket
      const cleanup = () => {
        active.delete(controller)
        outgoing.off('finish', cleanup)
        outgoing.off('close', cleanup)
        if (stopping && outgoing.writableFinished) socket.end()
      }
      outgoing.once('finish', cleanup)
      outgoing.once('close', cleanup)
      let clientId: string
      try {
        clientId = clientIdentity(incoming.socket.remoteAddress, request.headers, config.trustProxy)
      } catch {
        return failure(400, 'INVALID_CLIENT_ADDRESS', 'Invalid client address')
      }
      const path = new URL(request.url).pathname
      const operation =
        request.method === 'OPTIONS'
          ? undefined
          : path === '/api/parse'
            ? 'parse'
            : path === '/api/download'
              ? 'download'
              : undefined
      if (operation) {
        const max =
          operation === 'parse' ? config.maxConcurrentParses : config.maxConcurrentDownloads
        const perIp = downloadsByIp.get(clientId) ?? 0
        if (
          counts[operation] >= max ||
          (operation === 'download' && perIp >= config.maxDownloadsPerIp)
        ) {
          return failure(503, 'SERVER_BUSY', 'Server busy, retry later')
        }
        counts[operation]++
        if (operation === 'download') downloadsByIp.set(clientId, perIp + 1)
        let released = false
        const release = () => {
          if (released) return
          released = true
          counts[operation]--
          if (operation === 'download') {
            const remaining = (downloadsByIp.get(clientId) ?? 1) - 1
            if (remaining) downloadsByIp.set(clientId, remaining)
            else downloadsByIp.delete(clientId)
          }
          outgoing.off('finish', release)
          outgoing.off('close', release)
        }
        outgoing.once('finish', release)
        outgoing.once('close', release)
      }
      try {
        return protectResponseStream(
          await options.handler(request, runtime, { clientId }),
          outgoing,
          options.logger,
        )
      } catch {
        options.logger?.('request_failed')
        return failure(500, 'INTERNAL_ERROR', 'Internal server error')
      }
    },
    { overrideGlobalObjects: false, autoCleanupIncoming: true },
  )
  // Bound receiving headers/body, including clients that keep sending tiny chunks.
  // Node returns 408 and closes the connection; completed uploads and response
  // streams are not subject to this deadline. Check often enough to free slots.
  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 },
    listener,
  )
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return {
    server,
    runtime,
    listen(port = config.port): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(port, config.host, () => {
          server.off('error', onError)
          resolve(server.address() as AddressInfo)
        })
      })
    },
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise
      stopping = true
      limiter.close()
      shutdownPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          options.logger?.('shutdown_deadline')
          for (const controller of active)
            controller.abort(new DOMException('Server shutting down', 'AbortError'))
          for (const socket of sockets) socket.destroy()
        }, config.shutdownTimeoutMs)
        timer.unref()
        server.close((error) => {
          clearTimeout(timer)
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
            reject(error)
          else resolve()
        })
        server.closeIdleConnections()
      })
      return shutdownPromise
    },
  }
}
