// Deterministic bytes and data: this is an offline fixture, not Douyin evidence.
import { createServer } from 'node:http'
import { Buffer } from 'node:buffer'
import { URL } from 'node:url'

export const fixtureBytes = Buffer.from([0, 255, 128, 3, 4, 200, 6, 7, 8, 9])
export const fixtureId = '7690537093143539065'
export const fixtureSource = `https://www.douyin.com/video/${fixtureId}`
export const fixtureMedia = 'https://v.douyinvod.com/fixture-range.mp4'

export async function startFixture() {
  const hits = []
  const held = new Set()
  const state = { preview: false, released: false, pending: 0, completed: 0, hanging: [] }
  function sendItem(response, image = false, complete = false) {
    const body = JSON.stringify({
      aweme_detail: {
        aweme_id: fixtureId,
        desc: 'offline nginx fixture',
        author: { nickname: 'fixture author' },
        ...(image
          ? {
              images: [
                {
                  uri: 'fixture-image',
                  ...(complete
                    ? {
                        watermark_free_download_url_list: [
                          'https://p.douyinpic.com/fixture-final.jpg',
                        ],
                      }
                    : { url_list: ['https://p.douyinpic.com/fixture-preview.jpg'] }),
                },
              ],
            }
          : { video: { play_addr: { url_list: [fixtureMedia] } } }),
      },
    })
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    })
    response.end(body)
  }
  const server = createServer((request, response) => {
    hits.push({ path: request.url, headers: request.headers })
    const url = new URL(request.url, 'http://fixture.test')
    if (url.pathname === '/fixture-range.mp4') {
      const range = request.headers.range
      if (range && range !== 'bytes=2-5') {
        response.writeHead(416, {
          'Content-Type': 'text/html',
          'Content-Range': `bytes */${fixtureBytes.length}`,
          'Accept-Ranges': 'bytes',
        })
        return response.end('fixture range error: must never become downloaded media')
      }
      const bytes = range === 'bytes=2-5' ? fixtureBytes.subarray(2, 6) : fixtureBytes
      response.writeHead(range ? 206 : 200, {
        'Content-Type': 'video/mp4',
        'Content-Length': bytes.length,
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes 2-5/${fixtureBytes.length}` } : {}),
      })
      return response.end(bytes)
    }
    if (url.pathname === '/fixture-hold.mp4') {
      const record = { socket: request.socket, response, closed: false }
      state.hanging.push(record)
      request.socket.once('close', () => {
        record.closed = true
      })
      response.writeHead(200, { 'Content-Type': 'video/mp4' })
      response.write(fixtureBytes)
      return // Never ends on its own; cancellation must close the upstream socket.
    }
    if (url.pathname === '/fixture-failure.mp4') {
      response.writeHead(500)
      return response.end('offline fixture upstream failure')
    }
    if (url.pathname.includes('/aweme/') || url.pathname.startsWith('/video/')) {
      if (!state.preview) return sendItem(response)
      if (url.pathname.includes('/web/aweme/detail/')) return sendItem(response, true)
      if (state.released) return sendItem(response, true, true)
      state.pending++
      held.add(response)
      response.once('close', () => {
        held.delete(response)
      })
      return // The test releases this gate only AFTER receiving preview over HTTPS.
    }
    response.writeHead(404)
    response.end('offline fixture: unconfigured path')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    hits,
    state,
    origin: `http://127.0.0.1:${server.address().port}`,
    releasePreview() {
      state.released = true
      for (const response of held) {
        if (!response.destroyed) {
          state.completed++
          sendItem(response, true, true)
        }
      }
      held.clear()
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      }),
  }
}
