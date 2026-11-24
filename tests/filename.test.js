import { afterEach, expect, test, vi } from 'vitest'
import {
  buildCoverFilename,
  buildDownloadUrl,
  buildImageFilename,
  buildLivePhotoFilename,
  buildMusicFilename,
  buildVideoFilename,
  openDirectDownload,
} from '../frontend/src/utils/download'
import worker from '../worker/src/index'

const video = {
  platform: 'douyin',
  mediaType: 'video',
  videoId: '1234567890123456789',
  title: '标题',
  author: '作者',
}
const media = 'https://v.douyinvod.com/video.mp4'
const builders = [
  buildVideoFilename,
  buildCoverFilename,
  buildMusicFilename,
  (item) => buildImageFilename(item, 0),
  (item) => buildLivePhotoFilename(item, 0),
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([
  ['title', 46],
  ['title', 47],
  ['author', 46],
  ['author', 47],
])('all download filenames encode safely with emoji at the %s limit (%i)', (field, prefix) => {
  const item = { ...video, [field]: '字'.repeat(prefix) + '😀后续' }
  const expected = '字'.repeat(prefix) + (prefix === 46 ? '😀' : '')
  for (const build of builders) {
    const filename = build(item)
    expect(filename).toContain(expected + '_')
    expect(filename).toContain(video.videoId)
    expect(filename).not.toContain('后续')
    expect(filename).not.toContain('\uFFFD')
    const url = new URL(buildDownloadUrl(media, filename), 'https://api.example.com')
    expect(url.searchParams.get('filename')).toBe(filename)
    expect(url.searchParams.get('url')).toBe(media)
  }
})

test('malformed surrogate characters from upstream metadata cannot break URL encoding', () => {
  const filename = buildVideoFilename({ ...video, title: '前\uD83D中\uDE00后' })
  expect(filename).toContain('前\uFFFD中\uFFFD后')
  expect(() => buildDownloadUrl(media, filename)).not.toThrow()
})

test.each([
  ['normal.mp4', 'normal.mp4'],
  ['字'.repeat(178) + '😀.mp4', '字'.repeat(178) + '😀'],
  ['字'.repeat(179) + '😀.mp4', '字'.repeat(179)],
])('Worker streams media successfully with a bounded filename: %s', async (filename, expected) => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const bytes = new Uint8Array([1, 2, 3])
  const fetch = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } }))
  vi.stubGlobal('fetch', fetch)
  const url = new URL('https://api.example.com/api/download')
  url.searchParams.set('url', media)
  url.searchParams.set('filename', filename)
  const response = await worker.fetch(new Request(url), {
    DOWNLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
  })
  expect(response.status).toBe(200)
  const disposition = response.headers.get('Content-Disposition')
  expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(expected)
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes])
  expect(fetch).toHaveBeenCalledOnce()
})

test('sanitizes videoId path characters and preserves item suffixes at maximum metadata lengths', () => {
  const maxItem = {
    ...video,
    videoId: '../dir\\id:' + '9'.repeat(55),
    author: '作'.repeat(48),
    title: '标'.repeat(48),
  }
  const first = buildImageFilename(maxItem, 0)
  const second = buildImageFilename(maxItem, 1)
  const live = buildLivePhotoFilename(maxItem, 0)
  expect(first).not.toBe(second)
  expect(first).toMatch(/_01\.jpg$/)
  expect(second).toMatch(/_02\.jpg$/)
  expect(live).toMatch(/_实况_01\.mp4$/)
  for (const name of [first, second, live]) {
    expect(name).not.toMatch(/[\\/:"*?<>|]/)
    expect(name.startsWith('..')).toBe(false)
    expect(name.replace(/\.[^.]+$/, '').length).toBeLessThanOrEqual(150)
  }
})

test('openDirectDownload refuses non-HTTP(S) and credentialed URLs', () => {
  const clicks = []
  vi.stubGlobal('document', {
    body: { appendChild: vi.fn() },
    createElement: () => ({
      click() {
        clicks.push(this.href)
      },
      remove: vi.fn(),
    }),
  })
  openDirectDownload('javascript:alert(1)')
  openDirectDownload('data:text/html,<script>alert(1)</script>')
  openDirectDownload('https://user:pass@v.douyinvod.com/video.mp4')
  openDirectDownload('https://v.douyinvod.com/video.mp4')
  expect(clicks).toEqual(['https://v.douyinvod.com/video.mp4'])
})
