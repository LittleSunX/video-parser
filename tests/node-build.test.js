import { afterAll, beforeAll, expect, test } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
let dir
let output
const children = new Set()
beforeAll(async () => {
  const { buildServer } = await import('../server/build.mjs')
  dir = await mkdtemp(join(process.env.TMPDIR ?? join(root, 'server'), 'node-build-'))
  output = await buildServer({ outdir: dir })
}, 30_000)
afterAll(async () => {
  for (const child of children) child.kill()
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function freePort() {
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}
async function launch(extraEnv = {}) {
  const port = await freePort()
  // Windows kill(SIGTERM) is forceful, so deliver the OS event to the actual CLI listener via IPC.
  await writeFile(
    join(dir, 'signal-runner.mjs'),
    "process.on('message', m => { if (m === 'SIGTERM') process.emit('SIGTERM') }); await import('./index.mjs')\n",
  )
  const child = spawn(process.execPath, [join(dir, 'signal-runner.mjs')], {
    cwd: dir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY: 'none',
      SHUTDOWN_TIMEOUT_MS: '100',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.add(child)
  let text = ''
  child.stdout.on('data', (chunk) => {
    text += chunk
  })
  child.stderr.on('data', (chunk) => {
    text += chunk
  })
  const exit = once(child, 'exit').then(([code, signal]) => {
    children.delete(child)
    return { code, signal }
  })
  const url = `http://127.0.0.1:${port}`
  return { child, exit, url, logs: () => text }
}
async function health(app) {
  for (let i = 0; i < 100; i++) {
    if (app.child.exitCode !== null) throw Error('CLI exited: ' + app.logs())
    try {
      return await (await fetch(app.url + '/api/health')).json()
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw Error('CLI did not listen')
}
async function stop(app) {
  if (process.platform === 'win32') app.child.send('SIGTERM')
  else app.child.kill('SIGTERM')
  return app.exit
}

test('build emits one standalone ESM bundle and a strict immutable build identity', async () => {
  const version = JSON.parse(await readFile(join(dir, 'version.json'), 'utf8'))
  expect(version).toEqual({
    runtime: 'node',
    id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
    tag: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    timestamp: expect.any(String),
  })
  expect(new Date(version.timestamp).toISOString()).toBe(version.timestamp)
  const allowed = new Set(builtinModules.flatMap((name) => [name, 'node:' + name]))
  const imports = Object.values(output.metafile.outputs).flatMap((file) => file.imports)
  expect(imports.every((item) => item.external && allowed.has(item.path))).toBe(true)
  expect(await readFile(join(dir, 'index.mjs'), 'utf8')).not.toContain('cloudflare:')
  const { buildServer } = await import('../server/build.mjs')
  const next = await buildServer({ outdir: join(dir, 'next') })
  expect(next.version.id).not.toBe(version.id)
  expect(next.version.tag).toBe(version.tag)
})

test('bundled CLI runs without node_modules, survives cwd changes and keeps version across restarts', async () => {
  const version = JSON.parse(await readFile(join(dir, 'version.json'), 'utf8'))
  for (let i = 0; i < 2; i++) {
    const app = await launch()
    const result = await health(app)
    expect(result.data).toMatchObject({
      runtime: 'node',
      version: version.id,
      versionTag: version.tag,
      versionCreatedAt: version.timestamp,
    })
    expect(await stop(app)).toEqual({ code: 0, signal: null })
    expect(app.logs()).toContain('server_stopped')
  }
  expect(JSON.parse(await readFile(join(dir, 'version.json'), 'utf8'))).toEqual(version)
}, 10_000)

test('CLI refuses missing or invalid metadata and invalid configuration without disclosing values', async () => {
  const original = await readFile(join(dir, 'version.json'), 'utf8')
  const marker = 'PRIVATE_UPSTREAM?token=secret'
  try {
    for (const contents of [
      null,
      '{bad',
      JSON.stringify({ ...JSON.parse(original), id: marker }),
      JSON.stringify({ ...JSON.parse(original), tag: 'short' }),
    ]) {
      if (contents === null) await rm(join(dir, 'version.json'))
      else await writeFile(join(dir, 'version.json'), contents)
      const app = await launch()
      expect((await app.exit).code).toBe(1)
      expect(app.logs()).toContain('startup_failed')
      expect(app.logs()).not.toContain(marker)
      await expect(fetch(app.url + '/api/health')).rejects.toThrow()
    }
  } finally {
    await writeFile(join(dir, 'version.json'), original)
  }
  const invalid = await launch({ TRUST_PROXY: marker })
  expect((await invalid.exit).code).toBe(1)
  expect(invalid.logs()).not.toContain(marker)
}, 10_000)

test('version loader rejects incomplete, malformed and foreign metadata rather than inventing defaults', async () => {
  const { validateNodeVersion, loadVersion } = await import('../server/src/version.ts')
  const version = JSON.parse(await readFile(join(dir, 'version.json'), 'utf8'))
  expect(await loadVersion(join(dir, 'version.json'))).toEqual(version)
  expect(Object.isFrozen(validateNodeVersion(version))).toBe(true)
  for (const input of [
    null,
    {},
    { ...version, runtime: 'cloudflare-worker' },
    { ...version, id: 'unknown' },
    { ...version, tag: undefined },
    { ...version, tag: 'a'.repeat(39) },
    { ...version, timestamp: undefined },
    { ...version, timestamp: '2026-02-30T00:00:00.000Z' },
    { ...version, timestamp: 'not-a-date' },
  ])
    expect(() => validateNodeVersion(input)).toThrow('Invalid build metadata')
  await expect(loadVersion(resolve(dir, 'missing.json'))).rejects.toThrow('Invalid build metadata')
})
