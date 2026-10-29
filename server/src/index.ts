import { handleRequest } from '@video-parser/backend/http'
import { createApiServer } from './server'
import { readConfig } from './config'
import { loadVersion } from './version'

const log = (event: string) => console.info(JSON.stringify({ event, runtime: 'node' }))

async function main() {
  const config = readConfig()
  const version = await loadVersion(new URL('./version.json', import.meta.url))
  const app = createApiServer({ handler: handleRequest, version, config, logger: log })
  let stopping = false
  const stop = async (code: number) => {
    if (stopping) return
    stopping = true
    log('server_stopping')
    try {
      await app.shutdown()
      log('server_stopped')
      process.exit(code)
    } catch {
      log('shutdown_failed')
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => {
    void stop(0)
  })
  process.on('SIGINT', () => {
    void stop(0)
  })
  try {
    await app.listen()
  } catch {
    await app.shutdown()
    throw new Error('Unable to listen')
  }
  app.server.on('error', () => {
    log('server_failed')
    void stop(1)
  })
  log('server_listening')
}

void main().catch(() => {
  // Never log environment values, URLs, exception messages or stacks.
  log('startup_failed')
  process.exit(1)
})
