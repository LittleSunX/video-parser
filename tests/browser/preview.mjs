import { preview } from 'vite'
import { resolve } from 'node:path'

// Use real HTTP for native attachment downloads: intercepted navigation responses
// do not exercise the browser's normal download handling in every engine.
await preview({
  root: resolve('frontend'),
  configFile: resolve('frontend/vite.config.mjs'),
  preview: { host: '127.0.0.1', port: 4178, strictPort: true },
  plugins: [
    {
      name: 'offline-download-fixture',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url, 'http://127.0.0.1:4178')
          if (url.pathname !== '/api/download') return next()
          const bytes = Buffer.from('offline-video-content')
          response.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(bytes.length),
            'Content-Disposition':
              'attachment; filename="download"; filename*=UTF-8\'\'' +
              encodeURIComponent(url.searchParams.get('filename') || 'video.mp4'),
            'Cache-Control': 'no-store',
          })
          response.end(bytes)
        })
      },
    },
  ],
})
