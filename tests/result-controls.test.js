import { afterEach, expect, test, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { readFileSync } from 'node:fs'
import MobileDownloadBar from '../frontend/src/components/MobileDownloadBar.vue'
import ImageGallery from '../frontend/src/components/ImageGallery.vue'

afterEach(() => vi.unstubAllGlobals())
const render = (component, props) => renderToString(createSSRApp(component, props))

test.each([
  { visible: true, showTask: false, hidden: true },
  { visible: false, showTask: false, hidden: false },
  { visible: true, showTask: true, hidden: false },
])('fixed download action respects inline visibility and task state: %j', async (state) => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback) {
        this.callback = callback
      }
      observe(target) {
        this.callback([
          {
            target,
            isIntersecting: state.visible,
            intersectionRatio: state.visible ? 1 : 0,
          },
        ])
      }
      disconnect() {}
    },
  )
  const html = await render(MobileDownloadBar, {
    label: '打包下载全部',
    summary: '6 张图片',
    disabled: false,
    busy: false,
    showTask: state.showTask,
    actionElement: {},
  })
  expect(html.includes('display:none')).toBe(state.hidden)
  expect(html).toContain(state.showTask ? '查看任务' : '下载选项')
})

test.each([
  { url: 'https://example.com/photo.jpg', watermarkFree: true },
  { url: 'https://example.com/photo.jpg', livePhotoUrl: 'https://example.com/live.mp4' },
  { livePhotoUrl: 'https://example.com/live.mp4' },
])('current item exposes its available formats beside the image: %j', async (asset) => {
  const html = await render(ImageGallery, {
    images: [asset, { url: 'https://example.com/second.jpg' }],
    title: '测试作品',
    selectedIndex: 0,
    downloadDisabled: true,
  })
  const caption = html.match(/class="image-caption">([\s\S]*?)<\/div>/)?.[1]
  expect(caption).toBeTruthy()
  expect(caption.includes('动态 MP4')).toBe(Boolean(asset.livePhotoUrl))
  expect(caption.includes(asset.watermarkFree ? '无水印原图' : '高清原图')).toBe(Boolean(asset.url))
  const buttons = [...caption.matchAll(/<button\b([^>]*)>/g)]
  expect(buttons).toHaveLength(Number(Boolean(asset.url)) + Number(Boolean(asset.livePhotoUrl)))
  expect(buttons.every(([, attributes]) => attributes.includes('disabled'))).toBe(true)
})

test.each([
  [true, '无水印原图'],
  [false, '高清原图'],
])('still save accessible name includes its visible label %s: %s', async (watermarkFree, label) => {
  const html = await render(ImageGallery, {
    images: [
      { url: 'https://example.com/first.jpg', watermarkFree: !watermarkFree },
      { url: 'https://example.com/selected.jpg', watermarkFree },
    ],
    title: '测试作品',
    selectedIndex: 1,
    downloadDisabled: false,
  })
  const caption = html.match(/class="image-caption">([\s\S]*?)<\/div>/)?.[1]
  const button = [...caption.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(
    ([, , content]) => content.includes(label),
  )
  expect(button).toBeTruthy()
  const accessibleName = button[1].match(/aria-label="([^"]*)"/)?.[1]
  expect(accessibleName).toContain('第 2 张')
  expect(accessibleName).toContain(label)
})

test('the sidebar no longer duplicates item saves, while the parser remains directly accessible', () => {
  const app = readFileSync(new URL('../frontend/src/App.vue', import.meta.url), 'utf8')
  expect(app.includes('class="current-save"')).toBe(false)
  expect(app).toContain('@save-live="handleDownloadLivePhoto"')
  expect(app).toContain('<header class="hero">')
  expect(app).toContain(
    '<form class="parser-form" :aria-busy="loading" @submit.prevent="handleParse">',
  )
})

test('desktop images get a larger bounded canvas and a narrower information column', () => {
  const styles = readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8')
  const desktop = styles.split('@media')[0]
  expect(desktop.includes('grid-template-columns: minmax(0, 1fr) 330px;')).toBe(true)
  expect(desktop.includes('height: clamp(420px, calc(100dvh - 340px), 600px);')).toBe(true)
})

test('a single item still uses the main save controls without duplicate image actions', async () => {
  const html = await render(ImageGallery, {
    images: [
      { url: 'https://example.com/photo.jpg', livePhotoUrl: 'https://example.com/live.mp4' },
    ],
    title: '单项作品',
    selectedIndex: 0,
    downloadDisabled: false,
  })
  expect(html.includes('class="image-save-actions"')).toBe(false)
})
