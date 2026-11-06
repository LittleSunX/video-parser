import { monitorMain } from '../scripts/monitor-runtime.mjs'

monitorMain().catch(() => {
  console.error(JSON.stringify({ event: 'monitor_failed', code: 'MONITOR_RUN_FAILED' }))
  process.exitCode = 1
})
