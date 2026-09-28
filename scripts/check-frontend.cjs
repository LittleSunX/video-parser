const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parse, compileScript } = require('@vue/compiler-sfc')
const root = path.resolve(__dirname, '..')
const generated = path.join(root, 'frontend/src/.app-typecheck.ts')
const config = path.join(root, 'frontend/.tsconfig-check.json')
try {
  const source = fs.readFileSync(path.join(root, 'frontend/src/App.vue'), 'utf8')
  fs.writeFileSync(generated, compileScript(parse(source).descriptor, { id: 'typecheck' }).content)
  fs.writeFileSync(config, JSON.stringify({
    extends: './tsconfig.json',
    include: ['src/.app-typecheck.ts', 'src/api/**/*.ts', 'src/utils/**/*.ts', 'src/types/**/*.ts', 'src/env.d.ts', 'vite.config.ts'],
  }))
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', config, '--noEmit'], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  fs.rmSync(generated, { force: true })
  fs.rmSync(config, { force: true })
}
