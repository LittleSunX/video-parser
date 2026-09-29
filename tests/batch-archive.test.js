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
