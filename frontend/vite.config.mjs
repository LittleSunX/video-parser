import { execFileSync } from 'node:child_process'
import { env } from 'node:process'
import { posix } from 'node:path'
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

/** HTML 阶段就并行获取启动资源，CSS 只预载，避免阻塞静态反馈显示。 */
export function startupPreloadPlugin() {
  let base = '/'
  return {
    name: 'preload-startup-assets',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, { bundle, chunk, path: htmlPath }) {
        if (!bundle || !chunk) return []
        const application = chunk.dynamicImports
          .map((file) => bundle[file])
          .find(
            (entry) =>
              entry?.type === 'chunk' &&
              entry.facadeModuleId?.replaceAll('\\', '/').endsWith('/src/application.ts'),
          )
        if (!application) return []
        const scripts = new Set()
        const styles = new Set()
        function collect(entry) {
          if (scripts.has(entry.fileName)) return
          scripts.add(entry.fileName)
          for (const file of entry.imports) {
            const dependency = bundle[file]
            if (dependency?.type === 'chunk') collect(dependency)
          }
          for (const file of entry.viteMetadata?.importedCss ?? []) styles.add(file)
        }
        collect(application)
        function href(file) {
          if (base !== './' && base !== '') return base + file
          const relative = posix.relative(posix.dirname(htmlPath.slice(1)), file)
          return relative.startsWith('.') ? relative : './' + relative
        }
        return [
          ...[...scripts].map((file) => ({
            tag: 'link',
            attrs: { rel: 'modulepreload', crossorigin: 'anonymous', href: href(file) },
            injectTo: 'head',
          })),
          ...[...styles].map((file) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'style', crossorigin: 'anonymous', href: href(file) },
            injectTo: 'head',
          })),
        ]
      },
    },
  }
}

export default defineConfig({
  define: { 'import.meta.env.VITE_APP_COMMIT': JSON.stringify(buildVersion().commit) },
  plugins: [
    vue(),
    startupPreloadPlugin(),
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
