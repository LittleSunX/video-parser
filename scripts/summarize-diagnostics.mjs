import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { summarizeStream } from './diagnostics-summary.mjs'
export { createLogSummary, summarizeStream } from './diagnostics-summary.mjs'

async function main() {
  const args = process.argv.slice(2)
  if (!args.length || args.includes('--help')) {
    console.log('Usage: npm run diagnostics:summary -- <log.ndjson|-> [--version VERSION]')
    return
  }
  if (
    args.length !== 1 &&
    !(args.length === 3 && args[1] === '--version' && /^[a-zA-Z0-9-]{1,64}$/.test(args[2]))
  )
    throw new Error('Invalid arguments; use --help')
  const input = args[0] === '-' ? process.stdin : createReadStream(resolve(args[0]))
  try {
    console.log(JSON.stringify(await summarizeStream(input, { version: args[2] }), null, 2))
  } finally {
    if (input !== process.stdin) input.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Unable to summarize diagnostics; check arguments, file access and size limits.')
    process.exitCode = 1
  })
}
