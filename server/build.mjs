import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const directory = dirname(fileURLToPath(import.meta.url))

export async function buildServer({ outdir = join(directory, 'dist') } = {}) {
  const tag = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!/^[\da-f]{40}$/i.test(tag)) throw new Error('Full Git commit SHA required')
  const version = { runtime: 'node', id: randomUUID(), tag, timestamp: new Date().toISOString() }
  const result = await build({
    absWorkingDir: directory,
    entryPoints: ['src/index.ts'],
    outfile: join(resolve(outdir), 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'bundle',
    metafile: true,
    write: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  })
  const builtins = new Set(builtinModules.flatMap((name) => [name, 'node:' + name]))
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some((item) => !item.external || !builtins.has(item.path))) {
      throw new Error('Bundle contains a non-builtin runtime dependency')
    }
  }
  await mkdir(outdir, { recursive: true })
  for (const file of result.outputFiles) await writeFile(file.path, file.contents)
  await writeFile(join(outdir, 'version.json'), JSON.stringify(version, null, 2) + '\n')
  return { version, metafile: result.metafile }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version } = await buildServer()
    console.info(JSON.stringify({ event: 'server_built', ...version }))
  } catch {
    console.error(JSON.stringify({ event: 'server_build_failed' }))
    process.exitCode = 1
  }
}
