import { afterEach, expect, test, vi } from 'vitest'
import {
  createPreparedDownload,
  PREPARED_DOWNLOAD_TTL_MS,
} from '../frontend/src/utils/prepared-download'
import {
  createDownloadBufferBudget,
  PAGE_BUFFER_BUDGET_BYTES,
  SINGLE_BUFFER_BYTES,
  ZIP_PART_SOURCE_BYTES,
} from '../frontend/src/utils/download-buffer'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function browser() {
  const clicks = []
  vi.stubGlobal('document', {
    body: { appendChild: vi.fn() },
    createElement: () => ({
      click() {
        clicks.push({ href: this.href, filename: this.download })
      },
      remove: vi.fn(),
    }),
  })
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:prepared')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { clicks, create, revoke }
}

test('repeated click saves reuse one URL, and clearing releases the file immediately', () => {
  vi.useFakeTimers()
  const { clicks, create, revoke } = browser()
  const prepared = createPreparedDownload()
  const blob = new Blob(['same bytes'], { type: 'video/mp4' })
  prepared.prepare(blob, 'video.mp4')
  prepared.save()
  prepared.save()
  prepared.save()
  expect(clicks).toEqual(new Array(3).fill({ href: 'blob:prepared', filename: 'video.mp4' }))
  expect(create).toHaveBeenCalledExactlyOnceWith(blob)
  expect(revoke).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  prepared.clear()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:prepared')
  expect(prepared.canSave.value).toBe(false)
  expect(prepared.save()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

test('TTL releases the file and URL after the last save, without revoking an active retry early', async () => {
  vi.useFakeTimers()
  const { revoke } = browser()
  const expired = vi.fn()
  const prepared = createPreparedDownload(expired)
  prepared.prepare(new Blob(['data']), 'file.zip')
  prepared.save()
  await vi.advanceTimersByTimeAsync(PREPARED_DOWNLOAD_TTL_MS - 1)
  expect(prepared.canSave.value).toBe(true)
  prepared.save()
  await vi.advanceTimersByTimeAsync(1)
  expect(revoke).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(PREPARED_DOWNLOAD_TTL_MS - 1)
  expect(prepared.canSave.value).toBe(false)
  expect(revoke).toHaveBeenCalledOnce()
  expect(expired).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test('buffer tasks are mutually exclusive and a new task releases retained files before reserving', () => {
  const budget = createDownloadBufferBudget()
  const clearFirst = vi.fn()
  const first = budget.register(clearFirst)
  const second = budget.register(vi.fn())
  const releaseFirst = budget.acquire(first, PAGE_BUFFER_BUDGET_BYTES)
  expect(budget.busy.value).toBe(true)
  expect(budget.acquire(second, PAGE_BUFFER_BUDGET_BYTES)).toBeUndefined()
  expect(clearFirst).not.toHaveBeenCalled()
  budget.retain(first, SINGLE_BUFFER_BYTES)
  expect(budget.heldBytes.value).toBe(SINGLE_BUFFER_BYTES)
  releaseFirst()
  expect(budget.acquire(second, PAGE_BUFFER_BUDGET_BYTES + 1)).toBeUndefined()
  expect(clearFirst).not.toHaveBeenCalled()
  const releaseSecond = budget.acquire(second, PAGE_BUFFER_BUDGET_BYTES)
  expect(clearFirst).toHaveBeenCalledOnce()
  expect(budget.heldBytes.value).toBe(0)
  expect(budget.reservedBytes.value).toBe(PAGE_BUFFER_BUDGET_BYTES)
  releaseFirst()
  expect(budget.busy.value).toBe(true)
  releaseSecond()
  expect(budget.busy.value).toBe(false)
  expect(budget.reservedBytes.value).toBe(0)
  expect(ZIP_PART_SOURCE_BYTES).toBe(32 * 1024 * 1024)
})

test('retained buffers cannot exceed the page total, and native tasks cannot clear an active buffer', () => {
  const budget = createDownloadBufferBudget()
  const first = budget.register(vi.fn())
  const second = budget.register(vi.fn())
  budget.retain(first, SINGLE_BUFFER_BYTES)
  budget.retain(second, SINGLE_BUFFER_BYTES)
  expect(budget.heldBytes.value).toBe(PAGE_BUFFER_BUDGET_BYTES)
  expect(() => budget.retain(second, SINGLE_BUFFER_BYTES + 1)).toThrow('预算')
  const release = budget.acquire(first, PAGE_BUFFER_BUDGET_BYTES)
  expect(budget.clearRetained()).toBe(false)
  release()
  expect(budget.clearRetained()).toBe(true)
  expect(budget.heldBytes.value).toBe(0)
})
