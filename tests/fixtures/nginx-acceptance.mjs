// Run explicitly on Linux: node --test tests/fixtures/nginx-acceptance.mjs.
// Uses only stdlib, so a prebuilt bundle does not require Linux node_modules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const script = fileURLToPath(new URL('../../scripts/check-nginx.mjs', import.meta.url))

test(
  'real Linux deployment check exercises every contract and cleans its resources',
  {
    skip: process.platform !== 'linux',
    timeout: 90_000,
  },
  async () => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (bytes) => {
      stdout += bytes
    })
    child.stderr.on('data', (bytes) => {
      stderr += bytes
    })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    assert.equal(code, 0, stderr)
    for (const name of [
      'nginx -t',
      'HTTPS health/version/CORS',
      'static and API routing',
      'X-Real-IP spoof resistance',
      '32KiB application / 64KiB proxy limits',
      'incremental NDJSON preview',
      'Range 206/416 bytes',
      'disconnect cancels upstream',
      'safe logs: normal/400/502',
      'cleanup',
    ])
      assert.ok(stdout.includes(`PASS ${name}`), `Missing check ${name}\n${stdout}\n${stderr}`)
    const resources = JSON.parse(
      stdout.split('\n').find((line) => line.startsWith('{"resources":')),
    ).resources
    await assert.rejects(access(resources.directory), { code: 'ENOENT' })
    for (const pid of resources.pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  },
)
