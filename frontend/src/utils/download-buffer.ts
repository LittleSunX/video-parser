import { ref } from 'vue'

// 预算计入源媒体与输出 Blob；浏览器复制、解码和下载管理器占用不在此计数中。
export const PAGE_BUFFER_BUDGET_BYTES = 128 * 1024 * 1024
export const SINGLE_BUFFER_BYTES = PAGE_BUFFER_BUDGET_BYTES / 2
export const ZIP_PART_SOURCE_BYTES = PAGE_BUFFER_BUDGET_BYTES / 4

/** 页面内仅允许一个缓冲任务；开始另一任务时释放之前保留的文件。 */
export function createDownloadBufferBudget() {
  const busy = ref(false)
  const reservedBytes = ref(0)
  const heldBytes = ref(0)
  const owners = new Map<symbol, { clear: () => void; bytes: number }>()
  let active: symbol | undefined

  function register(clear: () => void): symbol {
    const owner = Symbol('download')
    owners.set(owner, { clear, bytes: 0 })
    return owner
  }

  function retain(owner: symbol, bytes: number) {
    const entry = owners.get(owner)
    if (!entry) return
    const total = heldBytes.value - entry.bytes + bytes
    if (bytes < 0 || total > PAGE_BUFFER_BUDGET_BYTES)
      throw new Error('当前下载文件超出页面缓冲预算')
    entry.bytes = bytes
    heldBytes.value = total
  }

  function acquire(owner: symbol, bytes: number): (() => void) | undefined {
    if (active || bytes > PAGE_BUFFER_BUDGET_BYTES || !owners.has(owner)) return
    // 同一批量任务的失败重试保留本包文件，其他任务释放其保存与重试引用。
    for (const [key, entry] of owners) {
      if (key !== owner) {
        entry.clear()
        retain(key, 0)
      }
    }
    const lease = Symbol('buffer-lease')
    active = lease
    busy.value = true
    reservedBytes.value = bytes
    return () => {
      if (active !== lease) return
      active = undefined
      busy.value = false
      reservedBytes.value = 0
    }
  }

  function clearRetained(): boolean {
    if (active) return false
    for (const [owner, entry] of owners) {
      entry.clear()
      retain(owner, 0)
    }
    return true
  }

  return { busy, reservedBytes, heldBytes, register, retain, acquire, clearRetained }
}

export type DownloadBufferBudget = ReturnType<typeof createDownloadBufferBudget>
