import { afterEach, expect, test, vi } from 'vitest'
import { createAttemptScheduler } from '../worker/src/parsers/douyin/attempt-scheduler'
import { DouyinParser } from '../worker/src/parsers/douyin'
import { parseVideo } from '../worker/src/services/parse-service'

const source = 'https://www.douyin.com/video/123'
const item = {
  aweme_id: '123',
  desc: '作品',
  author: { nickname: '作者' },
  video: {
    play_addr: { url_list: ['https://v.douyinvod.com/video'] },
    cover: { url_list: ['https://p.douyinpic.com/cover'] },
  },
  music: { title: '音乐', play_url: { url_list: ['https://sf.snssdk.com/music'] } },
}
function pending(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('a newly awakened first attempt takes the released permit before an older queued retry', async () => {
  const controller = new AbortController()
  let onRetry = () => {}
  const scheduler = createAttemptScheduler(controller.signal, () => onRetry())
  const other = await scheduler.acquire(1)
  const current = await scheduler.acquire(1)
  const order = []
  const oldRetry = scheduler.acquire(2).then((release) => {
    order.push('old')
    return release
  })
  let fresh
  onRetry = () => {
    fresh = scheduler.acquire(1).then((release) => {
      order.push('fresh')
      return release
    })
    onRetry = () => {}
  }
  current()
  const newRetry = scheduler.acquire(2).then((release) => {
    order.push('current')
    return release
  })
  const releaseFresh = await fresh
  expect(order).toEqual(['fresh'])
  releaseFresh()
  const releaseOld = await oldRetry
  expect(order).toEqual(['fresh', 'old'])
  releaseOld()
  const releaseCurrent = await newRetry
  expect(order).toEqual(['fresh', 'old', 'current'])
  releaseCurrent()
  other()
  controller.abort()
})

test('slow feed and a fast failing SSR cannot let an old web retry preempt page metadata', async () => {
  vi.useFakeTimers()
  const calls = []
  let web = 0
  let pages = 0
  let feedSignal
  const fetch = vi.fn(async (url, { signal }) => {
    if (url.includes('/aweme/v1/web/')) {
      web++
      calls.push('web-' + web)
      if (web === 2) await new Promise((resolve) => setTimeout(resolve, 700))
      return new Response('failed', { status: 403 })
    }
    if (url.includes('/aweme/v1/feed/')) {
      calls.push('feed')
      feedSignal = signal
      return pending(signal)
    }
    if (url === source) {
      pages++
      calls.push(pages === 1 ? 'ssr' : 'page-meta')
      if (pages === 1) return new Response('failed', { status: 403 })
      return new Response(
        '<a href="/video/123"></a><meta property="og:video" content="https://v.douyinvod.com/video">',
      )
    }
    calls.push('other')
    return new Response('failed', { status: 403 })
  })
  vi.stubGlobal('fetch', fetch)
  const running = new DouyinParser().parse(source)
  await vi.advanceTimersByTimeAsync(700)
  expect((await running).videoUrl).toBe('https://v.douyinvod.com/video')
  expect(calls).toEqual(['web-1', 'feed', 'web-2', 'ssr', 'page-meta'])
  expect(feedSignal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('body reads occupy both permits and a queued third strategy cannot fetch after selection', async () => {
  vi.useFakeTimers()
  let firstBody
  let feedSignal
  const fetch = vi.fn(
    async (url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            if (url.includes('/aweme/v1/web/')) firstBody = controller
            else feedSignal = signal
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
          },
        }),
      ),
  )
  vi.stubGlobal('fetch', fetch)
  const running = new DouyinParser().parse(source)
  await vi.advanceTimersByTimeAsync(599)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1201)
  expect(fetch).toHaveBeenCalledTimes(2)
  firstBody.enqueue(new TextEncoder().encode(JSON.stringify({ aweme_detail: item })))
  firstBody.close()
  expect(await running).toMatchObject({
    author: '作者',
    musicTitle: '音乐',
    parseStatus: 'complete',
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(feedSignal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('a fast SSR gets its first permit at eight seconds instead of waiting for three slow web attempts', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const starts = []
  const fetch = vi.fn(async (url) => {
    starts.push({ url, time: Date.now() })
    if (url.includes('/aweme/v1/')) {
      await new Promise((resolve) => setTimeout(resolve, 8000))
      return new Response('failed', { status: 403 })
    }
    return new Response(
      '<script>window._ROUTER_DATA = ' +
        JSON.stringify({ aweme_detail: item }) +
        '</script>' +
        ' '.repeat(1000),
    )
  })
  vi.stubGlobal('fetch', fetch)
  const running = new DouyinParser().parse(source)
  await vi.advanceTimersByTimeAsync(7999)
  expect(starts.map(({ time }) => time)).toEqual([0, 600])
  await vi.advanceTimersByTimeAsync(1)
  expect(await running).toMatchObject({
    author: '作者',
    musicTitle: '音乐',
    parseStatus: 'complete',
  })
  expect(starts.map(({ time }) => time)).toEqual([0, 600, 8000])
  expect(fetch).toHaveBeenCalledTimes(3)
  // Let the mock's aborted, signal-ignoring feed response settle without starting any retry.
  await vi.advanceTimersByTimeAsync(600)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})

test('full retry lists remain available and actual header/body attempts never exceed two', async () => {
  vi.useFakeTimers()
  let active = 0
  let maximum = 0
  let cancellations = 0
  const fetch = vi.fn(async (_url, { signal }) => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    let ended = false
    const finish = () => {
      if (ended) return
      ended = true
      active--
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener(
            'abort',
            () => {
              if (!ended) {
                finish()
                controller.error(signal.reason)
              }
            },
            { once: true },
          )
        },
        cancel() {
          cancellations++
          finish()
        },
      }),
      { status: 403 },
    )
  })
  vi.stubGlobal('fetch', fetch)
  const rejected = expect(new DouyinParser().parse(source)).rejects.toMatchObject({
    code: 'VIDEO_RESOURCE_NOT_FOUND',
  })
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(fetch).toHaveBeenCalledTimes(15)
  expect(maximum).toBe(2)
  expect(active).toBe(0)
  expect(cancellations).toBe(15)
  expect(vi.getTimerCount()).toBe(0)
})

test('client cancellation aborts the hung pair and all queued strategies without further fetches', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const signals = []
  const fetch = vi.fn((_url, { signal }) => {
    signals.push(signal)
    return pending(signal)
  })
  vi.stubGlobal('fetch', fetch)
  const rejected = expect(parseVideo(source, controller.signal)).rejects.toMatchObject({
    code: 'REQUEST_CANCELLED',
  })
  await vi.advanceTimersByTimeAsync(1800)
  expect(fetch).toHaveBeenCalledTimes(2)
  controller.abort()
  await rejected
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('the unchanged shared deadline returns known images, live tracks and metadata after preview', async () => {
  vi.useFakeTimers()
  const previews = []
  const images = [1, 2, 3].map((index) => ({
    url_list: ['https://p.douyinpic.com/' + index],
    video: { play_addr: { uri: 'live-' + index } },
  }))
  const signals = []
  const fetch = vi.fn((_url, { signal }) => {
    if (fetch.mock.calls.length === 1)
      return Promise.resolve(Response.json({ aweme_detail: { ...item, images } }))
    signals.push(signal)
    return pending(signal)
  })
  vi.stubGlobal('fetch', fetch)
  const running = parseVideo(source, undefined, undefined, (video) => previews.push(video))
  await vi.advanceTimersByTimeAsync(29999)
  expect(previews).toHaveLength(1)
  expect(previews[0].parseStatus).toBeUndefined()
  expect(previews[0].parseReason).toBeUndefined()
  expect(previews[0].images).toHaveLength(3)
  expect(previews[0].images.every((image) => image.livePhotoUrl)).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  expect(await running).toMatchObject({
    author: '作者',
    cover: 'https://p.douyinpic.com/1',
    musicTitle: '音乐',
    musicUrl: 'https://sf.snssdk.com/music',
    imagesComplete: true,
    parseStatus: 'unverified',
    parseReason: 'timeout',
  })
  expect((await running).images.every((image) => image.livePhotoUrl)).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
