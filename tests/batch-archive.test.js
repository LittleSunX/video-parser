import { afterEach, expect, test, vi } from 'vitest'
import { unzipSync } from 'fflate'
import {
  createBatchSession,
  downloadMediaArchive,
  saveArchivePart,
  clearBatchSession,
} from '../frontend/src/utils/batch-download'
import { createMediaArchive } from '../frontend/src/utils/media-archive'
import { saveBlob } from '../frontend/src/utils/auto-download'
import { buildDownloadUrl } from '../frontend/src/utils/download'

vi.mock('../frontend/src/utils/auto-download', async (importOriginal) => ({
  ...(await importOriginal()),
  saveBlob: vi.fn(),
}))
const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
  vi.useRealTimers()
  vi.mocked(saveBlob).mockClear()
})
const jobs = [1, 2, 3].map((i) => ({ url: 'https://cdn/' + i, filename: i + '.mp4' }))
const run = (session, signal = new AbortController().signal) =>
  downloadMediaArchive(jobs, '作品.zip', signal, () => {}, session)
async function entries(blob) {
  return unzipSync(new Uint8Array(await blob.arrayBuffer()))
}

for (const knownLength of [true, false]) {
  test(`split ZIPs retain all files and only save on clicks (Content-Length=${knownLength})`, async () => {
    const requests = []
    global.fetch = async (url) => {
      requests.push(url)
      return new Response(new Uint8Array(6).fill(Number(url.slice(-1))), {
        headers: { 'Content-Type': 'video/mp4', ...(knownLength ? { 'Content-Length': '6' } : {}) },
      })
    }
    const session = createBatchSession(jobs, 10)
    for (let i = 1; i <= 3; i++) {
      await run(session)
      expect(session.part.number).toBe(i)
      expect(session.files.size).toBe(0)
      expect(vi.mocked(saveBlob)).toHaveBeenCalledTimes(i - 1)
      const files = await entries(session.part.blob)
      expect(Object.keys(files)).toEqual([i + '.mp4'])
      expect([...files[i + '.mp4']]).toEqual(new Array(6).fill(i))
      // A second invocation cannot queue more downloads before the user saves this part.
      const count = requests.length
      await run(session)
      expect(requests).toHaveLength(count)
      expect(saveArchivePart(session)).toBe(i === 3)
      expect(session.part).toBeUndefined()
    }
    expect(vi.mocked(saveBlob).mock.calls.map((call) => call[1])).toEqual([
      '作品_第1包.zip',
      '作品_第2包.zip',
      '作品_第3包.zip',
    ])
  })
}

test('retry after a saved part only resumes remaining files and never repacks previous parts', async () => {
  let broken = false
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    if (broken) throw new TypeError('offline')
    return new Response(new Uint8Array(6).fill(Number(url.slice(-1))), {
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '6' },
    })
  }
  const session = createBatchSession(jobs, 6)
  await run(session)
  saveArchivePart(session)
  broken = true
  await expect(run(session)).rejects.toHaveProperty('code', 'NETWORK')
  expect(session.nextIndex).toBe(1)
  requests.length = 0
  broken = false
  await run(session)
  expect(requests).toEqual(['https://cdn/2'])
  expect(Object.keys(await entries(session.part.blob))).toEqual(['2.mp4'])
  clearBatchSession(session)
  expect(session.files.size).toBe(0)
  expect(session.part).toBeUndefined()
})

test('incremental archive preserves Unicode names and cancellation before saving', async () => {
  const files = new Map([['实况视频_01.mp4', new Blob([new Uint8Array([1, 2, 3])])]])
  const blob = await createMediaArchive(files, new AbortController().signal)
  expect(Object.keys(await entries(blob))).toEqual(['实况视频_01.mp4'])
  const controller = new AbortController()
  const source = new Blob(['data'])
  vi.spyOn(source, 'slice').mockImplementation(() => ({
    arrayBuffer: async () => {
      controller.abort()
      return new ArrayBuffer(4)
    },
  }))
  await expect(
    createMediaArchive(new Map([['cancel.mp4', source]]), controller.signal),
  ).rejects.toHaveProperty('name', 'AbortError')
  expect(saveBlob).not.toHaveBeenCalled()
})

test('a 31 MiB file succeeds with the 32 MiB default without whole-file arrayBuffer reads', async () => {
  const size = 31 * 1024 * 1024
  global.fetch = async () => {
    let chunks = 31
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks-- > 0) controller.enqueue(new Uint8Array(1024 * 1024).fill(7))
          else controller.close()
        },
      }),
      { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) } },
    )
  }
  const original = Blob.prototype.arrayBuffer
  let largestRead = 0
  const spy = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function () {
    largestRead = Math.max(largestRead, this.size)
    return original.call(this)
  })
  try {
    const one = [jobs[0]]
    await downloadMediaArchive(
      one,
      'large.zip',
      new AbortController().signal,
      () => {},
      createBatchSession(one),
    )
    expect(saveBlob).toHaveBeenCalledOnce()
    expect(vi.mocked(saveBlob).mock.calls[0][0].size).toBeGreaterThan(size)
    expect(largestRead).toBeLessThanOrEqual(256 * 1024)
  } finally {
    spy.mockRestore()
  }
}, 20000)

test('a failed first ZIP handoff preserves the prepared part without fetching or packing again', async () => {
  const fetch = vi.fn(
    async () => new Response('media', { headers: { 'Content-Type': 'video/mp4' } }),
  )
  global.fetch = fetch
  const one = [jobs[0]]
  const session = createBatchSession(one)
  const failedSave = vi.fn(() => {
    throw new Error('browser blocked')
  })
  await expect(
    downloadMediaArchive(
      one,
      'ready.zip',
      new AbortController().signal,
      () => {},
      session,
      () => {},
      failedSave,
    ),
  ).rejects.toThrow('browser blocked')
  const prepared = session.part.blob
  expect(session.files.size).toBe(0)
  expect(session.part.final).toBe(true)
  await downloadMediaArchive(one, 'ready.zip', new AbortController().signal, () => {}, session)
  expect(session.part.blob).toBe(prepared)
  expect(fetch).toHaveBeenCalledOnce()
  const save = vi.fn()
  expect(saveArchivePart(session, save)).toBe(true)
  expect(save).toHaveBeenCalledWith(prepared, 'ready.zip')
})

test('batch media transfer can progress beyond two minutes without a total deadline', async () => {
  vi.useFakeTimers()
  let source
  global.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller
        },
      }),
      { headers: { 'Content-Type': 'video/mp4' } },
    )
  const one = [jobs[0]]
  const running = downloadMediaArchive(
    one,
    'slow.zip',
    new AbortController().signal,
    () => {},
    createBatchSession(one),
  )
  for (let i = 0; i < 13; i++) {
    await vi.advanceTimersByTimeAsync(10000)
    source.enqueue(new Uint8Array([i]))
    await vi.advanceTimersByTimeAsync(0)
  }
  source.close()
  await running
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('proxy fallback permits slow headers and chunks without adding requests', async () => {
  vi.useFakeTimers()
  let proxySignal
  const requests = []
  global.fetch = (url, options) => {
    requests.push({ url, method: options.method ?? 'GET' })
    if (url === jobs[0].url) return Promise.reject(new TypeError('CORS'))
    proxySignal = options.signal
    return new Promise((resolve, reject) => {
      proxySignal.addEventListener('abort', () => reject(proxySignal.reason), { once: true })
      setTimeout(() => {
        if (proxySignal.aborted) return
        resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                proxySignal.addEventListener('abort', () => controller.error(proxySignal.reason), {
                  once: true,
                })
                controller.enqueue(new Uint8Array([1]))
                setTimeout(() => {
                  if (proxySignal.aborted) return
                  controller.enqueue(new Uint8Array([2]))
                  controller.close()
                }, 20000)
              },
            }),
            { headers: { 'Content-Type': 'video/mp4' } },
          ),
        )
      }, 10000)
    })
  }
  const one = [jobs[0]]
  const result = downloadMediaArchive(
    one,
    'slow-proxy.zip',
    new AbortController().signal,
    () => {},
    createBatchSession(one),
  ).then(
    () => ({ success: true }),
    (error) => ({ error }),
  )
  await vi.advanceTimersByTimeAsync(30000)
  expect(await result).toEqual({ success: true })
  expect(requests).toEqual([
    { url: jobs[0].url, method: 'GET' },
    { url: buildDownloadUrl(jobs[0].url, jobs[0].filename), method: 'GET' },
  ])
  expect(saveBlob).toHaveBeenCalledOnce()
  expect([...Object.values(await entries(vi.mocked(saveBlob).mock.calls[0][0]))[0]]).toEqual([1, 2])
  expect(vi.getTimerCount()).toBe(0)
})

test.each([
  ['response', 8000],
  ['read', 15000],
])('direct batch %s timeout remains %i ms before proxy fallback', async (phase, timeout) => {
  vi.useFakeTimers()
  const requests = []
  let directSignal
  global.fetch = (url, options) => {
    requests.push(url)
    if (url !== jobs[0].url)
      return Promise.resolve(
        new Response('proxy-media', { headers: { 'Content-Type': 'video/mp4' } }),
      )
    directSignal = options.signal
    if (phase === 'response')
      return new Promise((_resolve, reject) => {
        directSignal.addEventListener('abort', () => reject(directSignal.reason), { once: true })
      })
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            directSignal.addEventListener('abort', () => controller.error(directSignal.reason), {
              once: true,
            })
          },
        }),
        { headers: { 'Content-Type': 'video/mp4' } },
      ),
    )
  }
  const one = [jobs[0]]
  const running = downloadMediaArchive(one, 'direct.zip', new AbortController().signal, () => {})
  await vi.advanceTimersByTimeAsync(timeout - 1)
  expect(directSignal.aborted).toBe(false)
  expect(requests).toEqual([jobs[0].url])
  expect(saveBlob).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await running
  expect(directSignal.aborted).toBe(true)
  expect(requests).toEqual([jobs[0].url, buildDownloadUrl(jobs[0].url, jobs[0].filename)])
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test.each(['response', 'read'])(
  'cancelling proxy %s aborts without saving or retrying',
  async (phase) => {
    vi.useFakeTimers()
    let proxySignal
    const requests = []
    global.fetch = (url, options) => {
      requests.push(url)
      if (url === jobs[0].url) return Promise.reject(new TypeError('CORS'))
      proxySignal = options.signal
      if (phase === 'response')
        return new Promise((_resolve, reject) => {
          proxySignal.addEventListener('abort', () => reject(proxySignal.reason), { once: true })
        })
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              proxySignal.addEventListener('abort', () => controller.error(proxySignal.reason), {
                once: true,
              })
            },
          }),
          { headers: { 'Content-Type': 'video/mp4' } },
        ),
      )
    }
    const controller = new AbortController()
    const one = [jobs[0]]
    const session = createBatchSession(one)
    const running = downloadMediaArchive(one, 'cancel.zip', controller.signal, () => {}, session)
    const cancelled = expect(running).rejects.toHaveProperty('name', 'AbortError')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await cancelled
    expect(proxySignal.aborted).toBe(true)
    expect(requests).toEqual([jobs[0].url, buildDownloadUrl(jobs[0].url, jobs[0].filename)])
    expect(session.files.size).toBe(0)
    expect(session.nextIndex).toBe(0)
    expect(saveBlob).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  },
)

test('proxy timeout keeps completed files and retries only unfinished jobs', async () => {
  let failProxy = true
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    if (url === jobs[1].url) throw new TypeError('CORS')
    if (url === buildDownloadUrl(jobs[1].url, jobs[1].filename) && failProxy)
      return new Response('timeout', { status: 504 })
    return new Response('media', { headers: { 'Content-Type': 'video/mp4' } })
  }
  const session = createBatchSession(jobs)
  await expect(run(session)).rejects.toHaveProperty('code', 'TIMEOUT')
  expect(session.files.has(jobs[0].filename)).toBe(true)
  expect(session.nextIndex).toBe(1)
  expect(saveBlob).not.toHaveBeenCalled()
  requests.length = 0
  failProxy = false
  await run(session)
  expect(requests).toEqual([
    jobs[1].url,
    buildDownloadUrl(jobs[1].url, jobs[1].filename),
    jobs[2].url,
  ])
  expect(saveBlob).toHaveBeenCalledOnce()
  expect(Object.keys(await entries(vi.mocked(saveBlob).mock.calls[0][0]))).toEqual([
    '1.mp4',
    '2.mp4',
    '3.mp4',
  ])
})

test.each([true, false])(
  'proxy fallback keeps the part size limit (Content-Length=%s)',
  async (knownLength) => {
    const one = [jobs[0]]
    const session = createBatchSession(one, 3)
    const requests = []
    global.fetch = async (url) => {
      requests.push(url)
      if (url === jobs[0].url) throw new TypeError('CORS')
      return new Response(new Uint8Array(4), {
        headers: { 'Content-Type': 'video/mp4', ...(knownLength ? { 'Content-Length': '4' } : {}) },
      })
    }
    await expect(
      downloadMediaArchive(one, 'oversized.zip', new AbortController().signal, () => {}, session),
    ).rejects.toHaveProperty('code', 'TOO_LARGE')
    expect(requests).toEqual([jobs[0].url, buildDownloadUrl(jobs[0].url, jobs[0].filename)])
    expect(session.files.size).toBe(0)
    expect(session.nextIndex).toBe(0)
    expect(saveBlob).not.toHaveBeenCalled()
  },
)

const imageJobs = [1, 2, 3, 4].map((index) => ({
  url: 'https://cdn/image-' + index,
  filename: index + '.jpg',
}))
function controlledMedia(length = 4, type = 'image/jpeg') {
  const pending = new Map()
  const requests = []
  let active = 0
  let peak = 0
  global.fetch = async (url, options) => {
    requests.push(url)
    active++
    peak = Math.max(peak, active)
    let finished = false
    const done = () => {
      if (!finished) {
        finished = true
        active--
      }
    }
    options.signal.addEventListener('abort', done, { once: true })
    return new Response(
      new ReadableStream({
        start(source) {
          pending.set(url, {
            signal: options.signal,
            finish(size = length ?? 4) {
              source.enqueue(new Uint8Array(size).fill(Number(url.slice(-1))))
              source.close()
              done()
            },
            fail() {
              source.error(new TypeError('offline'))
              done()
            },
          })
        },
        cancel: done,
      }),
      {
        headers: { 'Content-Type': type, ...(length ? { 'Content-Length': String(length) } : {}) },
      },
    )
  }
  return { pending, requests, peak: () => peak, active: () => active }
}
const imageRun = (jobs, session, controller = new AbortController()) =>
  downloadMediaArchive(jobs, 'images.zip', controller.signal, () => {}, session)

test('small images overlap two at a time, preserve ZIP order, and never probe or duplicate GETs', async () => {
  const media = controlledMedia()
  const session = createBatchSession(imageJobs, 20)
  const running = imageRun(imageJobs, session)
  await vi.waitFor(() => expect(media.requests).toHaveLength(2))
  media.pending.get(imageJobs[1].url).finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(media.requests).toHaveLength(2)
  expect(saveBlob).not.toHaveBeenCalled()
  media.pending.get(imageJobs[0].url).finish()
  await vi.waitFor(() => expect(media.requests).toHaveLength(4))
  media.pending.get(imageJobs[3].url).finish()
  media.pending.get(imageJobs[2].url).finish()
  await running
  expect(media.peak()).toBe(2)
  expect(media.requests).toEqual(imageJobs.map(({ url }) => url))
  const files = await entries(vi.mocked(saveBlob).mock.calls[0][0])
  expect(Object.keys(files)).toEqual(imageJobs.map(({ filename }) => filename))
  expect(Object.values(files).map((bytes) => [...bytes])).toEqual(
    [1, 2, 3, 4].map((i) => [i, i, i, i]),
  )
})

test.each([
  [null, 'image/jpeg', '.jpg'],
  [11, 'image/jpeg', '.jpg'],
  [4, 'video/mp4', '.mp4'],
])('unknown or large images and videos stay serial (%s, %s)', async (length, type, extension) => {
  const list = imageJobs
    .slice(0, 2)
    .map((job) => ({ ...job, filename: job.filename.replace('.jpg', extension) }))
  const media = controlledMedia(length, type)
  const running = imageRun(list, createBatchSession(list, 20))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(media.requests).toHaveLength(1)
  media.pending.get(list[0].url).finish()
  await vi.waitFor(() => expect(media.requests).toHaveLength(2))
  if (length !== 11) media.pending.get(list[1].url).finish()
  await running
  expect(media.peak()).toBe(1)
})

test('prefetched files use only remaining part capacity and split without losing data', async () => {
  const list = imageJobs.slice(0, 2)
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    const size = url === list[0].url ? 4 : 8
    return new Response(new Uint8Array(size).fill(size), {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(size) },
    })
  }
  const session = createBatchSession(list, 10)
  await imageRun(list, session)
  expect(session.part.count).toBe(1)
  expect(session.part.final).toBe(false)
  const first = await entries(session.part.blob)
  expect([...first['1.jpg']]).toEqual(new Array(4).fill(4))
  expect(saveArchivePart(session)).toBe(false)
  await imageRun(list, session)
  expect(session.part.final).toBe(true)
  const second = await entries(session.part.blob)
  expect([...second['2.jpg']]).toEqual(new Array(8).fill(8))
  expect(requests).toEqual([list[0].url, list[1].url, list[1].url])
})

test('cancellation stops both image transfers and cannot save or initiate a proxy retry', async () => {
  const media = controlledMedia()
  const controller = new AbortController()
  const session = createBatchSession(imageJobs, 20)
  const running = imageRun(imageJobs, session, controller)
  const rejected = expect(running).rejects.toHaveProperty('name', 'AbortError')
  await vi.waitFor(() => expect(media.requests).toHaveLength(2))
  controller.abort()
  await rejected
  expect([...media.pending.values()].every(({ signal }) => signal.aborted)).toBe(true)
  expect(media.active()).toBe(0)
  expect(media.requests).toHaveLength(2)
  expect(session.files.size).toBe(0)
  expect(saveBlob).not.toHaveBeenCalled()
})

test('prefetch failure retains committed images and retry only fetches unfinished files', async () => {
  const list = imageJobs.slice(0, 3)
  let broken = true
  const requests = []
  global.fetch = async (url) => {
    requests.push(url)
    if (broken && (url === list[1].url || url === buildDownloadUrl(list[1].url, list[1].filename)))
      throw new TypeError('offline')
    return new Response(new Uint8Array(4), {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4' },
    })
  }
  const session = createBatchSession(list, 20)
  await expect(imageRun(list, session)).rejects.toHaveProperty('code', 'NETWORK')
  expect(session.nextIndex).toBe(1)
  expect([...session.files.keys()]).toEqual(['1.jpg'])
  expect(saveBlob).not.toHaveBeenCalled()
  requests.length = 0
  broken = false
  await imageRun(list, session)
  expect(requests).toEqual([list[1].url, list[2].url])
  expect(Object.keys(await entries(vi.mocked(saveBlob).mock.calls[0][0]))).toEqual([
    '1.jpg',
    '2.jpg',
    '3.jpg',
  ])
})

test('underreported length cannot exceed an image reservation or leave its peer running', async () => {
  const media = controlledMedia()
  const session = createBatchSession(imageJobs, 20)
  const running = imageRun(imageJobs, session)
  const rejected = expect(running).rejects.toHaveProperty('code', 'TOO_LARGE')
  await vi.waitFor(() => expect(media.requests).toHaveLength(2))
  media.pending.get(imageJobs[0].url).finish(6)
  await rejected
  expect(media.pending.get(imageJobs[1].url).signal.aborted).toBe(true)
  expect(session.files.size).toBe(0)
  expect(media.requests).toHaveLength(2)
  expect(saveBlob).not.toHaveBeenCalled()
})
