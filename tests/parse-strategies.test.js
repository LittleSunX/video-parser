import { afterEach, expect, test, vi } from 'vitest'
import { runParseStrategies } from '../worker/src/parsers/douyin/strategies'

afterEach(() => vi.useRealTimers())
const imageResult = (clean = true) => ({
  imagesComplete: true,
  video: {
    mediaType: 'image',
    images: [1, 2, 3].map((i) => ({
      url: `https://images/${i}.jpg`,
      livePhotoUrl: `https://videos/${i}.mp4`,
      watermarkFree: clean,
    })),
  },
})
function pending(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('fast complete primary avoids all backup requests', async () => {
  const backup = vi.fn()
  const result = imageResult()
  expect(
    await runParseStrategies([
      { name: 'primary', run: async () => result },
      { name: 'backup', run: backup },
    ]),
  ).toBe(result.video)
  expect(backup).not.toHaveBeenCalled()
})

test('slow primary is hedged after 600ms and cancelled when backup completes', async () => {
  vi.useFakeTimers()
  let primarySignal
  const backup = vi.fn(async () => imageResult())
  const running = runParseStrategies([
    {
      name: 'primary',
      run: (signal) => {
        primarySignal = signal
        return pending(signal)
      },
    },
    { name: 'backup', run: backup },
  ])
  await vi.advanceTimersByTimeAsync(599)
  expect(backup).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect((await running).images).toHaveLength(3)
  expect(primarySignal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('incomplete live result continues seeking clean images with at most two active strategies', async () => {
  vi.useFakeTimers()
  let active = 0
  let maximum = 0
  let slowSignal
  const start = () => {
    active++
    maximum = Math.max(maximum, active)
  }
  const running = runParseStrategies([
    { name: 'primary', run: async () => imageResult(false) },
    {
      name: 'slow',
      run: async (signal) => {
        slowSignal = signal
        start()
        try {
          return await pending(signal)
        } finally {
          active--
        }
      },
    },
    {
      name: 'clean',
      run: async () => {
        start()
        active--
        return imageResult()
      },
    },
    {
      name: 'unused',
      run: () => {
        throw new Error('should not run')
      },
    },
  ])
  await vi.advanceTimersByTimeAsync(600)
  const result = await running
  expect(result.images.every((image) => image.watermarkFree && image.livePhotoUrl)).toBe(true)
  expect(maximum).toBe(2)
  expect(slowSignal.aborted).toBe(true)
})

test('both occupied slots prevent a third request and cancellation aborts both', async () => {
  vi.useFakeTimers()
  const signals = []
  const run = vi.fn((signal) => {
    signals.push(signal)
    return pending(signal)
  })
  const controller = new AbortController()
  const running = runParseStrategies(
    [1, 2, 3, 4].map((i) => ({ name: String(i), run })),
    controller.signal,
  )
  const rejected = expect(running).rejects.toHaveProperty('name', 'AbortError')
  await vi.advanceTimersByTimeAsync(1800)
  expect(run).toHaveBeenCalledTimes(2)
  controller.abort()
  await rejected
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

test('clean still-only fallback cannot replace the three known dynamic tracks', async () => {
  const original = imageResult(false)
  const stills = imageResult()
  stills.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const result = await runParseStrategies([
    { name: 'live', run: async () => original },
    { name: 'stills', run: async () => stills },
  ])
  expect(result.images).toEqual(
    original.video.images.map((image) => ({ ...image, watermarkFree: true })),
  )
})

test('shorter clean result cannot replace a longer known image list at exhaustion', async () => {
  const full = imageResult(false)
  full.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const shorter = imageResult()
  shorter.video.images = shorter.video.images.slice(0, 2)
  shorter.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const result = await runParseStrategies([
    { name: 'full', run: async () => full },
    { name: 'short-clean', run: async () => shorter },
  ])
  expect(result.images).toEqual(
    full.video.images.map((image, i) => ({ ...image, watermarkFree: i < 2 })),
  )
  expect(result.images).toHaveLength(3)
})

test('longer result replaces an earlier partial clean list despite its lower quality score', async () => {
  const partial = imageResult()
  partial.imagesComplete = false
  partial.video.images = partial.video.images.slice(0, 2)
  partial.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const full = imageResult(false)
  full.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const result = await runParseStrategies([
    { name: 'partial', run: async () => partial },
    { name: 'full', run: async () => full },
  ])
  expect(result.images).toEqual(
    full.video.images.map((image, i) => ({ ...image, watermarkFree: i < 2 })),
  )
})

test('shared timeout returns the longer list after seeing a shorter clean fallback', async () => {
  const controller = new AbortController()
  const full = imageResult(false)
  full.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const shorter = imageResult()
  shorter.video.images = shorter.video.images.slice(0, 2)
  shorter.video.images.forEach((image) => {
    delete image.livePhotoUrl
  })
  const result = await runParseStrategies(
    [
      { name: 'full', run: async () => full },
      { name: 'short-clean', run: async () => shorter },
      {
        name: 'timeout',
        run: (signal) => {
          controller.abort(new DOMException('deadline', 'TimeoutError'))
          return pending(signal)
        },
      },
    ],
    controller.signal,
  )
  expect(result.images).toEqual(
    full.video.images.map((image, i) => ({ ...image, watermarkFree: i < 2 })),
  )
})
