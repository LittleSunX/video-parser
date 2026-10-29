import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const execFileAsync = promisify(execFile)

// A separate browser build deliberately has no Wrangler/Node compatibility shims.
// It does not load .env/.dev.vars, authenticate, deploy, or use a fixed dev port.
export async function checkWorkerBuild({
  root = repositoryRoot,
  entryPoint = 'worker/src/index.ts',
} = {}) {
  const outdir = await mkdtemp(join(tmpdir(), 'video-parser-worker-build-'))
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entryPoint],
      outfile: join(outdir, 'worker.mjs'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      metafile: true,
      logLevel: 'silent',
    })
    const paths = [
      ...Object.keys(result.metafile.inputs),
      ...Object.values(result.metafile.inputs).flatMap((input) =>
        input.imports.map((item) => item.path),
      ),
      ...Object.values(result.metafile.outputs).flatMap((output) =>
        output.imports.map((item) => item.path),
      ),
    ]
    for (const path of paths) {
      const normalized = path.replaceAll('\\', '/')
      if (/(^|\/)server\/src(?:\/|$)/.test(normalized)) {
        throw new Error('Worker bundle crosses the server/src boundary: ' + path)
      }
      if (normalized.startsWith('node:') || builtins.has(normalized)) {
        throw new Error('Worker bundle imports a Node builtin: ' + path)
      }
    }
    return result.metafile
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

async function checkWranglerBuild() {
  const directory = await mkdtemp(join(tmpdir(), 'video-parser-wrangler-build-'))
  try {
    // Copy only the checked-in deployment config into an empty scratch directory.
    // Wrangler must not discover a developer's .env or .dev.vars during this check.
    const source = await readFile(join(repositoryRoot, 'worker/wrangler.jsonc'), 'utf8')
    const config = source.replace(
      '"main": "src/index.ts"',
      '"main": ' + JSON.stringify(join(repositoryRoot, 'worker/src/index.ts')),
    )
    if (config === source) throw new Error('Unable to locate the Worker entry in wrangler.jsonc')
    const path = join(directory, 'wrangler.jsonc')
    await writeFile(path, config)
    await execFileAsync(
      process.execPath,
      [
        join(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--config',
        path,
        '--outdir',
        join(directory, 'dist'),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: 'false',
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
          CI: 'true',
        },
        timeout: 25_000,
      },
    )
    const bundle = await readFile(join(directory, 'dist/index.js'), 'utf8')
    if (!bundle.includes('cloudflare-worker')) throw new Error('Worker dry-run artifact missing')
    process.stdout.write('Wrangler dry-run verified; no deployment performed.\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const metafile = await checkWorkerBuild()
  process.stdout.write(
    `Worker browser build verified: ${Object.keys(metafile.inputs).length} inputs; no server/src or Node builtins.\n`,
  )
  await checkWranglerBuild()
}
