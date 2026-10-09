import { afterEach, expect, test, vi } from 'vitest'
import { createAttemptScheduler } from '../worker/src/parsers/douyin/attempt-scheduler'
import {
  runOrderedCandidates,
  mergeKnownResults,
} from '../worker/src/parsers/douyin/ordered-candidates'
import { extractImageAssets, hasAllImageResources } from '../worker/src/parsers/douyin/images'
import { runParseStrategies } from '../worker/src/parsers/douyin/strategies'
import { DouyinParser } from '../worker/src/parsers/douyin'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function pending(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
function imageResult({
  clean = false,
  live = false,
  complete = true,
  ids = ['one', 'two', 'three'],
  author = 'preferred author',
  music = 'preferred',
  missingLive = false,
} = {}) {
  const images = extractImageAssets(
    ids.map((uri) => ({
      uri,
      ...(clean
        ? { watermark_free_download_url_list: ['https://images/clean-' + uri] }
        : { url_list: ['https://images/watermarked-' + uri] }),
      ...(live
        ? { video: { play_addr: { uri: 'live-' + uri } } }
        : missingLive
          ? { video: {} }
          : {}),
    })),
  )
  return {
    imagesComplete: complete,
    video: {
      platform: 'douyin',
      mediaType: 'image',
      videoId: '123',
      sourceUrl: 'https://www.douyin.com/video/123',
      title: 'preferred title',
      author,
      cover: 'https://images/cover',
      musicUrl: 'https://audio/' + music,
      musicTitle: music + ' title',
      images,
    },
  }
}
const videoResult = () => ({
  imagesComplete: true,
  video: {
    platform: 'douyin',
    mediaType: 'video',
    videoId: '123',
    sourceUrl: 'https://www.douyin.com/video/123',
    title: 'video',
    videoUrl: 'https://video/preferred',
    author: 'video author',
  },
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('first attempts and normal retries precede an older speculative waiter', async () => {
  const controller = new AbortController()
  const scheduler = createAttemptScheduler(controller.signal, () => {})
  const first = await scheduler.acquire(1)
  const second = await scheduler.acquire(1)
  const order = []
  const speculative = scheduler.schedule(2, { speculative: true })
  const lookahead = speculative.permit.then((release) => {
    order.push('spec')
    return release
  })
  const retry = scheduler.acquire(2).then((release) => {
    order.push('retry')
    return release
  })
  const fresh = scheduler.acquire(1).then((release) => {
    order.push('first')
    return release
  })
  first()
  const releaseFirst = await fresh
  expect(order).toEqual(['first'])
  releaseFirst()
  const releaseRetry = await retry
  expect(order).toEqual(['first', 'retry'])
  releaseRetry()
  const releaseSpec = await lookahead
  expect(order).toEqual(['first', 'retry', 'spec'])
  releaseSpec()
  second()
  controller.abort()
})

test('speculation waits for all strategies to launch and promotion wakes a new first attempt', async () => {
  let eligible = false
  let scheduler
  let releaseFresh
  const controller = new AbortController()
  scheduler = createAttemptScheduler(
    controller.signal,
    () => {
      eligible = true
      scheduler.acquire(1).then((release) => {
        releaseFresh = release
      })
    },
    () => eligible,
  )
  const releaseHead = await scheduler.acquire(1)
  const ticket = scheduler.schedule(2, { speculative: true })
  let started = false
  const running = ticket.permit.then((release) => {
    started = true
    return release
  })
  await Promise.resolve()
  expect(started).toBe(false)
  ticket.promote()
  await Promise.resolve()
  expect(releaseFresh).toBeTypeOf('function')
  expect(started).toBe(false)
  releaseFresh()
  const releaseNext = await running
  expect(started).toBe(true)
  releaseNext()
  releaseHead()
  controller.abort()
})

test('cancelling a queued speculative attempt removes it without taking a later permit', async () => {
  const controller = new AbortController()
  const scheduler = createAttemptScheduler(controller.signal, () => {})
  const releaseOne = await scheduler.acquire(1)
  const releaseTwo = await scheduler.acquire(1)
  const cancellation = new AbortController()
  const ticket = scheduler.schedule(2, { speculative: true, signal: cancellation.signal })
  const rejected = expect(ticket.permit).rejects.toHaveProperty('name', 'AbortError')
  cancellation.abort()
  await rejected
  releaseOne()
  const releaseNormal = await scheduler.acquire(2)
  releaseNormal()
  releaseTwo()
  controller.abort()
})

test('four failed two-second candidates finish in four seconds with no new endpoints or third request', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const controller = new AbortController()
  const starts = []
  let active = 0
  let peak = 0
  let done = false
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    async (index) => {
      starts.push({ index, time: Date.now() })
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2000))
      active--
    },
  ).then((result) => {
    done = true
    return result
  })
  await vi.advanceTimersByTimeAsync(3999)
  expect(done).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await running).toBeUndefined()
  expect(starts).toEqual([
    { index: 0, time: 0 },
    { index: 1, time: 0 },
    { index: 2, time: 2000 },
    { index: 3, time: 2000 },
  ])
  expect(peak).toBe(2)
  expect(active).toBe(0)
})

test('a later success waits for the earlier endpoint and does not start a third candidate', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const head = deferred()
  const later = imageResult({ clean: true, author: 'later author', music: 'later' })
  const earlier = imageResult({ live: true })
  const starts = []
  const retained = []
  let done = false
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    async (index) => {
      starts.push(index)
      return index === 0 ? head.promise : later
    },
    (result) => retained.push(result),
  ).then((result) => {
    done = true
    return result
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(starts).toEqual([0, 1])
  expect(retained).toHaveLength(1)
  expect(done).toBe(false)
  head.resolve(earlier)
  await vi.advanceTimersByTimeAsync(0)
  const result = await running
  expect(result.video.author).toBe('preferred author')
  expect(result.video.musicUrl).toBe('https://audio/preferred')
  expect(result.video.musicTitle).toBe('preferred title')
  expect(result.video.images).toHaveLength(3)
  expect(result.video.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(hasAllImageResources(result.video.images)).toBe(true)
  expect(starts).toEqual([0, 1])
})

test('a buffered next success is selected after the earlier failure with at most one extra started endpoint', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const head = deferred()
  const starts = []
  const expected = imageResult({ clean: true })
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    async (index) => {
      starts.push(index)
      return index === 0 ? head.promise : expected
    },
  )
  await vi.advanceTimersByTimeAsync(0)
  head.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(await running).toBe(expected)
  expect(starts).toEqual([0, 1])
})

test('simultaneously delivered successes retain endpoint metadata priority and the clean live union', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const earlier = imageResult({ live: true })
  const later = imageResult({ clean: true, author: 'later', music: 'later' })
  const values = [deferred(), deferred()]
  const run = vi.fn((index) => values[index].promise)
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    run,
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(2)
  values[0].resolve(earlier)
  values[1].resolve(later)
  await vi.advanceTimersByTimeAsync(0)
  const result = await running
  expect(result.video.author).toBe('preferred author')
  expect(result.video.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(run).toHaveBeenCalledTimes(2)
})

test('an ordered video winner stays video when a later endpoint reports images', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const head = deferred()
  const earlier = videoResult()
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    async (index) => (index === 0 ? head.promise : imageResult({ clean: true })),
  )
  await vi.advanceTimersByTimeAsync(0)
  head.resolve(earlier)
  await vi.advanceTimersByTimeAsync(0)
  const result = await running
  expect(result.video.mediaType).toBe('video')
  expect(result.video.videoUrl).toBe('https://video/preferred')
  expect(result.video.images).toBeUndefined()
})

test('explicit incomplete declarations and missing declared live resources stay conservative', () => {
  const earlier = imageResult({ clean: true })
  const missing = imageResult({ clean: true, complete: false, missingLive: true })
  const merged = mergeKnownResults(earlier, missing)
  expect(merged.imagesComplete).toBe(false)
  expect(hasAllImageResources(merged.video.images)).toBe(false)
  const disjoint = mergeKnownResults(imageResult({ ids: ['one'] }), imageResult({ ids: ['two'] }))
  expect(disjoint.video.images).toHaveLength(2)
  expect(disjoint.imagesComplete).toBe(false)
})

test('a selected head cancels queued lookahead and never starts it after a permit frees', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const scheduler = createAttemptScheduler(controller.signal, () => {})
  const other = await scheduler.acquire(1)
  const run = vi.fn(async () => videoResult())
  const running = runOrderedCandidates(4, controller.signal, scheduler, run)
  await vi.advanceTimersByTimeAsync(0)
  const result = await running
  expect(result.video.mediaType).toBe('video')
  other()
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(1)
})

test('body consumption holds both permits and cancellation clears queued and running candidates', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const scheduler = createAttemptScheduler(controller.signal, () => {})
  const signals = []
  const run = vi.fn(async (_index, signal) => {
    signals.push(signal)
    const response = new Response(
      new ReadableStream({
        start(output) {
          signal.addEventListener('abort', () => output.error(signal.reason), { once: true })
        },
      }),
    )
    await response.text()
  })
  const rejected = expect(
    runOrderedCandidates(4, controller.signal, scheduler, run),
  ).rejects.toHaveProperty('name', 'AbortError')
  await vi.advanceTimersByTimeAsync(0)
  const third = scheduler.acquire(1)
  const thirdRejected = expect(third).rejects.toHaveProperty('name', 'AbortError')
  expect(run).toHaveBeenCalledTimes(2)
  controller.abort()
  await rejected
  await thirdRejected
  await vi.advanceTimersByTimeAsync(0)
  expect(run).toHaveBeenCalledTimes(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test('shared deadline keeps a buffered later success while its earlier endpoint is still pending', async () => {
  vi.useFakeTimers()
  const deadline = new AbortController()
  const later = imageResult({ live: true, clean: true })
  const running = runParseStrategies(
    [
      {
        name: 'mobile-feed',
        run: (signal, attempts, retain) =>
          runOrderedCandidates(
            4,
            signal,
            attempts,
            async (index, candidateSignal) => (index === 0 ? pending(candidateSignal) : later),
            retain,
          ),
      },
    ],
    deadline.signal,
  )
  await vi.advanceTimersByTimeAsync(0)
  deadline.abort(new DOMException('deadline', 'TimeoutError'))
  const result = await running
  expect(result).toMatchObject({
    author: 'preferred author',
    musicTitle: 'preferred title',
    imagesComplete: true,
    parseStatus: 'unverified',
    parseReason: 'timeout',
  })
  expect(result.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(hasAllImageResources(result.images)).toBe(true)
})

test('client cancellation rejects even when a buffered candidate already contains usable images', async () => {
  vi.useFakeTimers()
  const cancellation = new AbortController()
  const running = runParseStrategies(
    [
      {
        name: 'mobile-feed',
        run: (signal, attempts, retain) =>
          runOrderedCandidates(
            4,
            signal,
            attempts,
            async (index, candidateSignal) =>
              index === 0 ? pending(candidateSignal) : imageResult(),
            retain,
          ),
      },
    ],
    cancellation.signal,
  )
  const rejected = expect(running).rejects.toHaveProperty('name', 'AbortError')
  await vi.advanceTimersByTimeAsync(0)
  cancellation.abort()
  await rejected
})

test('a normal high-quality result keeps metadata and clean images over a lower-priority retained snapshot', async () => {
  vi.useFakeTimers()
  const fresh = deferred()
  const preferred = imageResult({ clean: true, live: true })
  const snapshot = imageResult({ author: 'lower priority', music: 'lower' })
  const running = runParseStrategies([
    {
      name: 'mobile-feed',
      run: (signal, _attempts, retain) => {
        retain(snapshot)
        return pending(signal)
      },
    },
    { name: 'mobile-ssr', run: () => fresh.promise },
  ])
  await vi.advanceTimersByTimeAsync(600)
  fresh.resolve(preferred)
  const result = await running
  expect(result.author).toBe('preferred author')
  expect(result.musicUrl).toBe('https://audio/preferred')
  expect(result.imagesComplete).toBe(true)
  expect(result.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(result.parseReason).toBe('complete')
})

test('fast web video remains one upstream request and does not start feed speculation', async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      aweme_detail: {
        aweme_id: '123',
        desc: 'video',
        video: { play_addr: { url_list: ['https://v.douyinvod.com/video'] } },
      },
    }),
  )
  vi.stubGlobal('fetch', fetch)
  expect((await new DouyinParser().parse('https://www.douyin.com/video/123')).mediaType).toBe(
    'video',
  )
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('immediately fulfilled candidates preserve both clean and live resources before selection', async () => {
  const controller = new AbortController()
  const earlier = imageResult({ live: true })
  const later = imageResult({ clean: true, author: 'later', music: 'later' })
  const run = vi.fn(async (index) => (index === 0 ? earlier : later))
  const result = await runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    run,
  )
  expect(result.video.author).toBe('preferred author')
  expect(result.video.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(run).toHaveBeenCalledTimes(2)
})

test('already completed JSON and extraction microtasks are retained without waiting for a slow lookahead', async () => {
  const controller = new AbortController()
  const earlier = imageResult({ live: true })
  const later = imageResult({ clean: true })
  const run = vi.fn(async (index) => {
    if (index === 0) return earlier
    await Response.json({ complete: true }).json()
    await Promise.resolve()
    await Promise.resolve()
    return later
  })
  const result = await runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    run,
  )
  expect(result.video.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(run).toHaveBeenCalledTimes(2)
})

test('a slow started lookahead is cancelled on the selection task without its own timeout budget', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const controller = new AbortController()
  const signals = []
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    async (index, signal) => {
      signals.push(signal)
      return index === 0 ? imageResult({ clean: true }) : pending(signal)
    },
  )
  await vi.advanceTimersByTimeAsync(0)
  expect((await running).video.images.every((image) => image.watermarkFree)).toBe(true)
  expect(Date.now()).toBe(0)
  expect(signals).toHaveLength(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('abort during the queued selection task clears its timer and cannot start another endpoint', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const head = deferred()
  const signals = []
  const run = vi.fn(async (index, signal) => {
    signals.push(signal)
    return index === 0 ? head.promise : pending(signal)
  })
  const running = runOrderedCandidates(
    4,
    controller.signal,
    createAttemptScheduler(controller.signal, () => {}),
    run,
  )
  const rejected = expect(running).rejects.toHaveProperty('name', 'AbortError')
  await vi.advanceTimersByTimeAsync(0)
  head.resolve(imageResult({ clean: true }))
  for (let i = 0; i < 6; i++) await Promise.resolve()
  expect(vi.getTimerCount()).toBe(1)
  controller.abort()
  await rejected
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(run).toHaveBeenCalledTimes(2)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
})

test('real feed lookahead keeps fixed endpoint order and fills metadata from its earlier winner', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const source = 'https://www.douyin.com/video/123'
  const feedStarts = []
  const requests = []
  const primaryImages = ['one', 'two', 'three'].map((uri) => ({
    uri,
    url_list: ['https://p.douyinpic.com/' + uri],
    video: { play_addr: { uri: 'live-' + uri } },
  }))
  let active = 0
  let peak = 0
  const fetch = vi.fn(async (url) => {
    if (url.includes('/aweme/v1/web/'))
      return Response.json({
        aweme_detail: { aweme_id: '123', desc: 'primary', images: primaryImages },
      })
    if (!url.includes('/aweme/v1/feed/')) return new Response('failed', { status: 403 })
    const index = feedStarts.length
    feedStarts.push({ url, time: Date.now() })
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 1000 : 100))
    active--
    const images = primaryImages.map((image) => ({
      uri: image.uri,
      ...(index === 0
        ? { url_list: image.url_list }
        : { watermark_free_download_url_list: ['https://p.douyinpic.com/clean-' + image.uri] }),
    }))
    return Response.json({
      aweme_detail: {
        aweme_id: '123',
        desc: 'feed',
        author: { nickname: index === 0 ? 'earlier author' : 'later author' },
        music: {
          title: index === 0 ? 'earlier music' : 'later music',
          play_url: { url_list: ['https://audio/' + index] },
        },
        images,
      },
    })
  })
  vi.stubGlobal('fetch', fetch)
  const trace = {
    requestId: 'test',
    version: 'test',
    emit: (event, data) => requests.push({ event, ...data }),
  }
  const running = new DouyinParser().parse(source, undefined, trace)
  await vi.advanceTimersByTimeAsync(999)
  expect(feedStarts).toHaveLength(2)
  expect(feedStarts[0].url).toContain('api5-normal-c-hl.amemv.com')
  expect(feedStarts[0].url).toContain('aid=6383')
  expect(feedStarts[1].url).toContain('api5-normal-c-hl.amemv.com')
  expect(feedStarts[1].url).toContain('aid=1128')
  await vi.advanceTimersByTimeAsync(1)
  await vi.advanceTimersByTimeAsync(1)
  const result = await running
  expect(result).toMatchObject({
    author: 'earlier author',
    musicTitle: 'earlier music',
    musicUrl: 'https://audio/0',
    imagesComplete: true,
    parseReason: 'complete',
  })
  expect(result.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(peak).toBe(2)
  expect(feedStarts).toHaveLength(2)
  expect(
    requests
      .filter(({ event, strategy }) => event === 'upstream_attempt' && strategy === 'mobile-feed')
      .map(({ endpoint, attempt, result }) => [endpoint, attempt, result])
      .sort((left, right) => left[1] - right[1]),
  ).toEqual([
    ['feed-amemv-6383', 1, 'success'],
    ['feed-amemv-1128', 2, 'success'],
  ])
})

test('a standalone selection holds global queued work until its result is delivered', async () => {
  const controller = new AbortController()
  const scheduler = createAttemptScheduler(controller.signal, () => {})
  const other = await scheduler.acquire(1)
  const events = []
  const running = runOrderedCandidates(4, controller.signal, scheduler, async () => {
    events.push('head-success')
    return videoResult()
  })
  const waiting = scheduler.acquire(1).then((release) => {
    events.push('global-work')
    return release
  })
  await running
  events.push('selected')
  expect(events).toEqual(['head-success', 'selected'])
  const release = await waiting
  expect(events).toEqual(['head-success', 'selected', 'global-work'])
  release()
  other()
  controller.abort()
})

test('scope holds span helper and adapter awaits until selector cancels unnecessary global work', async () => {
  vi.useFakeTimers()
  const events = []
  const running = runParseStrategies([
    {
      name: 'other',
      run: async (signal, attempts) => {
        const release = await attempts.acquire(1)
        try {
          return await pending(signal)
        } finally {
          release()
        }
      },
    },
    {
      name: 'feed',
      run: async (signal, attempts, retain) => {
        const result = await runOrderedCandidates(
          4,
          signal,
          attempts,
          async () => {
            events.push('head-success')
            void attempts.acquire(1).then(
              (release) => {
                events.push('unnecessary-fetch')
                release()
              },
              () => {},
            )
            return videoResult()
          },
          retain,
        )
        // Model parseFromMobileFeed and strategy wrappers without guessing their microtask count.
        await Promise.resolve()
        await Promise.resolve()
        return result
      },
    },
  ])
  await vi.advanceTimersByTimeAsync(700)
  expect((await running).videoUrl).toBe('https://video/preferred')
  expect(events).toEqual(['head-success'])
  expect(vi.getTimerCount()).toBe(0)
})

test('scope holds resume normal work after accepting an image result that still needs quality supplementation', async () => {
  vi.useFakeTimers()
  const deadline = new AbortController()
  const events = []
  let queuedRelease
  const running = runParseStrategies(
    [
      {
        name: 'other',
        run: async (signal, attempts) => {
          const release = await attempts.acquire(1)
          try {
            return await pending(signal)
          } finally {
            release()
          }
        },
      },
      {
        name: 'feed',
        run: async (signal, attempts, retain) => {
          const result = await runOrderedCandidates(
            4,
            signal,
            attempts,
            async () => {
              events.push('head-success')
              void attempts.acquire(1).then(
                (release) => {
                  queuedRelease = release
                  events.push('quality-fetch')
                },
                () => {},
              )
              return imageResult()
            },
            retain,
          )
          await Promise.resolve()
          return result
        },
      },
    ],
    deadline.signal,
    undefined,
    () => events.push('preview'),
  )
  await vi.advanceTimersByTimeAsync(700)
  expect(events).toEqual(['head-success', 'preview', 'quality-fetch'])
  queuedRelease()
  deadline.abort(new DOMException('deadline', 'TimeoutError'))
  expect((await running).images).toHaveLength(3)
  expect(vi.getTimerCount()).toBe(0)
})

test('a failed strategy releases its scope holds before the next queued strategy runs', async () => {
  const running = runParseStrategies([
    {
      name: 'failed',
      run: async (_signal, attempts) => {
        attempts.hold()
        throw new Error('failed')
      },
    },
    {
      name: 'video',
      run: async (_signal, attempts) => {
        const release = await attempts.acquire(1)
        try {
          return videoResult()
        } finally {
          release()
        }
      },
    },
  ])
  expect((await running).videoUrl).toBe('https://video/preferred')
})

test('real Douyin adapter holds queued first attempts when another request releases during feed selection', async () => {
  vi.useFakeTimers()
  const webRetry = deferred()
  const calls = []
  let web = 0
  const fetch = vi.fn(async (url) => {
    if (url.includes('/aweme/v1/web/')) {
      calls.push('web-' + ++web)
      return web === 2 ? webRetry.promise : new Response('failed', { status: 403 })
    }
    if (url.includes('/aweme/v1/feed/')) {
      calls.push('feed')
      return Response.json({
        aweme_detail: {
          aweme_id: '123',
          desc: 'video',
          video: { play_addr: { url_list: ['https://v.douyinvod.com/video'] } },
        },
      })
    }
    calls.push('unnecessary-page-fetch')
    return new Response('failed', { status: 403 })
  })
  vi.stubGlobal('fetch', fetch)
  const trace = {
    requestId: 'test',
    version: 'test',
    emit(event, fields) {
      if (
        event === 'upstream_attempt' &&
        fields.strategy === 'mobile-feed' &&
        fields.result === 'success'
      ) {
        // This runs before the runner's zero-delay selection task, while real adapter awaits remain.
        setTimeout(() => webRetry.resolve(new Response('failed', { status: 403 })), 0)
      }
    },
  }
  const running = new DouyinParser().parse('https://www.douyin.com/video/123', undefined, trace)
  await vi.advanceTimersByTimeAsync(1)
  expect((await running).videoUrl).toBe('https://v.douyinvod.com/video')
  expect(calls).toEqual(['web-1', 'feed', 'web-2'])
  expect(vi.getTimerCount()).toBe(0)
})
