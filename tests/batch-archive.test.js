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

test('a 65 MiB file succeeds with the new 128 MiB default without whole-file arrayBuffer reads', async () => {
  const size = 65 * 1024 * 1024
  global.fetch = async () => {
    let chunks = 65
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
