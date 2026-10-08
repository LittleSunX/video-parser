import { execFileSync } from 'node:child_process'
import { env } from 'node:process'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

function buildVersion() {
  let commit = env.VERCEL_GIT_COMMIT_SHA ?? ''
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      commit = 'unknown'
    }
  }
  return {
    commit: /^[a-f0-9]{40}$/i.test(commit) ? commit : 'unknown',
    builtAt: new Date().toISOString(),
  }
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'build-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify(buildVersion(), null, 2) + '\n',
        })
      },
    },
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
