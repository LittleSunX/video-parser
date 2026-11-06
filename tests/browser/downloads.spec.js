import { test, expect, devices } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'

const videoBytes = Buffer.from('offline-video-content')
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rSAAAAAASUVORK5CYII=',
  'base64',
)
const media = (path) => 'https://media.test/' + path
const video = (id = '123456789') => ({
  platform: 'douyin',
  mediaType: 'video',
  videoId: id,
  sourceUrl: 'https://www.douyin.com/video/' + id,
  title: '离线视频 ' + id,
  videoUrl: media(id + '.mp4'),
})
const gallery = (large = false) => ({
  ...video(),
  mediaType: 'image',
  videoUrl: undefined,
  title: '离线图集',
  imagesComplete: true,
  images: [1, 2].map((i) => ({
    url: media(`${large ? 'large-' : ''}${i}.png`),
    watermarkFree: true,
  })),
})

async function setup(page, { result = video(), direct, proxy } = {}) {
  const calls = { direct: [], proxy: [], unexpected: [] }
  // All external traffic is intercepted; fixtures never contact production or Douyin.
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === 'http://127.0.0.1:4178') {
      if (url.pathname === '/api/parse') {
        const data = typeof result === 'function' ? result(route.request()) : result
        return route.fulfill({ json: { success: true, data } })
      }
      if (url.pathname === '/api/download') {
        calls.proxy.push(url.searchParams.get('url'))
        if (proxy) return proxy(route, url)
        return route.continue()
      }
      return route.continue()
    }
    if (url.origin === 'https://media.test') {
      calls.direct.push(url.pathname)
      if (direct && route.request().resourceType() !== 'image') return direct(route, url)
      const image = url.pathname.endsWith('.png')
      const body = image ? imageBytes : videoBytes
      return route.fulfill({
        body,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': image ? 'image/png' : 'video/mp4',
        },
      })
    }
    calls.unexpected.push(url.origin)
    return route.abort()
  })
  await page.goto('/')
  return calls
}

async function parse(page, id = '123456789') {
  await page.getByLabel('分享链接或分享文案').fill('https://www.douyin.com/video/' + id)
  await page.getByRole('button', { name: '解析链接', exact: true }).click()
  await expect(page.getByRole('region', { name: '解析结果', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '解析链接', exact: true })).toBeEnabled()
}

async function download(page, button) {
  const pending = page.waitForEvent('download')
  await button.click()
  const file = await pending
  expect(await file.failure()).toBeNull()
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) }
}

test('direct download and save again preserve filename and bytes without fetching twice', async ({
  page,
}) => {
  const calls = await setup(page)
  await parse(page)
  const first = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(first.name).toContain('123456789')
  expect(first.name).toMatch(/\.mp4$/)
  expect(first.bytes).toEqual(videoBytes)
  const second = await download(
    page,
    page.getByRole('button', { name: '再次保存视频', exact: true }),
  )
  expect(second).toEqual(first)
  expect(calls.direct).toHaveLength(1)
  expect(calls.proxy).toEqual([])
  expect(calls.unexpected).toEqual([])
})

test('failed direct request falls back to a browser attachment', async ({ page }) => {
  const calls = await setup(page, { direct: (route) => route.abort('failed') })
  await parse(page)
  const file = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(file.bytes).toEqual(videoBytes)
  expect(calls.proxy).toEqual([video().videoUrl])
  await expect(page.getByRole('region', { name: '下载任务' })).toContainText('备用下载')
  expect(calls.unexpected).toEqual([])
})

for (const failedStatus of [403, 503, 206]) {
  test(`an HTTP ${failedStatus} primary uses the complete direct mirror without a proxy request`, async ({
    page,
  }) => {
    const primary = video()
    const alternative = media('same-quality.mp4')
    const calls = await setup(page, {
      result: { ...primary, videoUrlAlternatives: [alternative] },
      direct: (route, url) =>
        route.request().resourceType() === 'document'
          ? route.fulfill({ body: 'Opened direct link', contentType: 'text/html' })
          : route.fulfill({
              status: url.pathname === '/same-quality.mp4' ? 200 : failedStatus,
              body:
                url.pathname === '/same-quality.mp4'
                  ? videoBytes
                  : failedStatus === 206
                    ? videoBytes.subarray(0, 4)
                    : 'Unavailable',
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Range',
                'Content-Type':
                  url.pathname === '/same-quality.mp4' || failedStatus === 206
                    ? 'video/mp4'
                    : 'text/html',
                ...(url.pathname !== '/same-quality.mp4' && failedStatus === 206
                  ? { 'Content-Range': `bytes 0-3/${videoBytes.length}` }
                  : {}),
              },
            }),
    })
    await parse(page)
    const file = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
    expect(file.bytes).toEqual(videoBytes)
    expect(file.name).toContain(primary.videoId)
    expect(calls.direct).toEqual(['/123456789.mp4', '/same-quality.mp4'])
    expect(calls.proxy).toEqual([])
    expect(calls.unexpected).toEqual([])
    await page.getByText('备用下载与直链', { exact: true }).click()
    await expect(page.getByRole('button', { name: '切换直链（2/2）', exact: true })).toBeVisible()
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: '打开直链', exact: true }).click()
    const popup = await opened
    await expect(popup).toHaveURL(alternative)
    await popup.close()
  })
}

test('manual direct link selection controls the next download and resets after parsing again', async ({
  page,
}) => {
  const calls = await setup(page, {
    result: (request) => {
      const current = video(new URLSearchParams(request.postData()).get('url').split('/').at(-1))
      return { ...current, videoUrlAlternatives: [media('same-quality.mp4')] }
    },
  })
  await parse(page)
  await page.getByText('备用下载与直链', { exact: true }).click()
  await page.getByRole('button', { name: '切换直链（1/2）', exact: true }).click()
  const file = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(file.bytes).toEqual(videoBytes)
  expect(calls.direct).toEqual(['/same-quality.mp4'])
  expect(calls.proxy).toEqual([])
  await parse(page, '987654321')
  await page.getByText('备用下载与直链', { exact: true }).click()
  await expect(page.getByRole('button', { name: '切换直链（1/2）', exact: true })).toBeVisible()
  await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(calls.direct).toEqual(['/same-quality.mp4', '/987654321.mp4'])
})

test('exhausted direct mirrors launch only one proxy request with the refusal reason', async ({
  page,
}) => {
  const calls = await setup(page, {
    result: { ...video(), videoUrlAlternatives: [media('same-quality.mp4')] },
    direct: (route) =>
      route.fulfill({
        status: 403,
        body: 'Forbidden',
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/html' },
      }),
  })
  await parse(page)
  const file = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(file.bytes).toEqual(videoBytes)
  expect(calls.direct).toEqual(['/123456789.mp4', '/same-quality.mp4'])
  expect(calls.proxy).toEqual([video().videoUrl])
  await expect(page.getByRole('region', { name: '下载任务' })).toContainText('HTTP 403')
})

test.describe('Android download entry', () => {
  test.use({
    viewport: devices['Pixel 7'].viewport,
    userAgent: devices['Pixel 7'].userAgent,
    isMobile: true,
    hasTouch: true,
  })

  test('the mobile action saves the direct mirror after the primary is denied', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Android Chrome uses Chromium')
    const calls = await setup(page, {
      result: { ...video(), videoUrlAlternatives: [media('same-quality.mp4')] },
      direct: (route, url) =>
        route.fulfill({
          status: url.pathname === '/same-quality.mp4' ? 200 : 403,
          body: url.pathname === '/same-quality.mp4' ? videoBytes : 'Forbidden',
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': url.pathname === '/same-quality.mp4' ? 'video/mp4' : 'text/html',
          },
        }),
    })
    await parse(page)
    const action = page
      .getByRole('region', { name: '快捷下载' })
      .getByRole('button', { name: '下载视频', exact: true })
    const file = await download(page, action)
    expect(file.bytes).toEqual(videoBytes)
    expect(calls.direct).toEqual(['/123456789.mp4', '/same-quality.mp4'])
    expect(calls.proxy).toEqual([])
  })
})

test('cancelled download releases the UI and a fresh download can finish', async ({ page }) => {
  let stalled
  let count = 0
  await setup(page, {
    direct: async (route) => {
      if (++count === 1) {
        stalled = route
        return
      }
      await route.fulfill({
        body: videoBytes,
        contentType: 'video/mp4',
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    },
  })
  await parse(page)
  await page.getByRole('button', { name: '下载视频', exact: true }).click()
  await expect.poll(() => Boolean(stalled)).toBe(true)
  await page.getByRole('button', { name: '取消下载', exact: true }).click()
  await expect(page.getByRole('region', { name: '下载任务' })).toContainText('已取消')
  await stalled.abort().catch(() => {})
  const file = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(file.bytes).toEqual(videoBytes)
})

test('gallery ZIP contains every original image and can be saved again', async ({ page }) => {
  await setup(page, { result: gallery() })
  await parse(page)
  const file = await download(page, page.getByRole('button', { name: '打包下载全部', exact: true }))
  const files = unzipSync(file.bytes)
  expect(Object.keys(files)).toHaveLength(2)
  expect(Object.keys(files).every((name) => name.endsWith('.png'))).toBe(true)
  for (const bytes of Object.values(files)) expect(Buffer.from(bytes)).toEqual(imageBytes)
  const again = await download(
    page,
    page.getByRole('button', { name: '再次保存 ZIP', exact: true }),
  )
  expect(again).toEqual(file)
})

test('large gallery saves consecutive ZIP parts without repeating an image', async ({ page }) => {
  await setup(page, {
    result: gallery(true),
    direct: (route, url) =>
      route.fulfill({
        body: Buffer.alloc(17 * 1024 * 1024, url.pathname.includes('1') ? 1 : 2),
        headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
      }),
  })
  await parse(page)
  await page.getByRole('button', { name: '打包下载全部', exact: true }).click()
  const first = await download(page, page.getByRole('button', { name: /^保存第 1 包/ }))
  await page.getByRole('button', { name: '继续准备下一包', exact: true }).click()
  const second = await download(page, page.getByRole('button', { name: /^保存第 2 包/ }))
  const entries = [unzipSync(first.bytes), unzipSync(second.bytes)]
  expect(new Set(entries.flatMap(Object.keys)).size).toBe(2)
  for (const [index, files] of entries.entries()) {
    expect(Object.values(files)).toHaveLength(1)
    const bytes = Object.values(files)[0]
    expect(bytes.byteLength).toBe(17 * 1024 * 1024)
    const digest = (value) => createHash('sha256').update(value).digest('hex')
    expect(digest(bytes)).toBe(digest(Buffer.alloc(bytes.byteLength, index + 1)))
  }
  await expect(page.getByRole('button', { name: '继续准备下一包', exact: true })).toHaveCount(0)
})

test('switching works clears the previous prepared download', async ({ page }) => {
  await setup(page, {
    result: (request) =>
      video(new URLSearchParams(request.postData()).get('url').split('/').at(-1)),
  })
  await parse(page)
  await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  await page.getByRole('button', { name: '清空链接与解析结果' }).click()
  await parse(page, '987654321')
  await expect(page.getByRole('button', { name: '再次保存视频', exact: true })).toHaveCount(0)
  const next = await download(page, page.getByRole('button', { name: '下载视频', exact: true }))
  expect(next.name).toContain('987654321')
  expect(next.name).not.toContain('123456789')
})

test('retrying a partial gallery keeps completed files and fetches only the missing item', async ({
  page,
}) => {
  let fail = true
  const requests = []
  await setup(page, {
    result: gallery(),
    direct: (route, url) => {
      requests.push(url.pathname)
      if (fail && url.pathname === '/2.png') return route.abort('failed')
      return route.fulfill({
        body: imageBytes,
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
        },
      })
    },
    proxy: (route) => route.fulfill({ status: 503, body: 'busy' }),
  })
  await parse(page)
  await page.getByRole('button', { name: '打包下载全部', exact: true }).click()
  const retry = page.getByRole('button', { name: '重试未完成项', exact: true })
  await expect(retry).toBeVisible()
  fail = false
  requests.length = 0
  const file = await download(page, retry)
  expect(requests).toEqual(['/2.png'])
  const files = unzipSync(file.bytes)
  expect(Object.keys(files)).toHaveLength(2)
  for (const bytes of Object.values(files)) expect(Buffer.from(bytes)).toEqual(imageBytes)
  await expect(retry).toHaveCount(0)
})
