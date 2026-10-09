import { ref } from 'vue'
import { saveBlob } from './auto-download'

export const PREPARED_DOWNLOAD_TTL_MS = 30000

/** 仅保留当前下载任务的文件，供浏览器未接管时再次点击保存。 */
export function createPreparedDownload(onExpire: () => void = () => {}) {
  const canSave = ref(false)
  let file: { blob: Blob; filename: string } | undefined
  let objectUrl: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear() {
    clearTimeout(timer)
    timer = undefined
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = undefined
    file = undefined
    canSave.value = false
  }

  function armExpiry() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      clear()
      onExpire()
    }, PREPARED_DOWNLOAD_TTL_MS)
  }

  function prepare(blob: Blob, filename: string) {
    if (file?.blob === blob && file.filename === filename) {
      armExpiry()
      return
    }
    clear()
    file = { blob, filename }
    canSave.value = true
    armExpiry()
  }

  // 保持同步，调用方可直接在按钮 click 内调用，不丢失本次用户手势。
  function save(): boolean {
    if (!file) return false
    objectUrl = saveBlob(file.blob, file.filename, { objectUrl, retain: true })
    armExpiry()
    return true
  }

  return { canSave, prepare, save, clear }
}
