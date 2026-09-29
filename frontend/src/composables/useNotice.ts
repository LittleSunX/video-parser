import { ref, onScopeDispose } from 'vue'

export function useNotice() {
  const notice = ref('')
  let noticeTimer: number | undefined
  function showNotice(message: string, duration = 3000) {
    clearNotice()
    notice.value = message
    noticeTimer = window.setTimeout(() => {
      notice.value = ''
      noticeTimer = undefined
    }, duration)
  }

  function clearNotice() {
    notice.value = ''
    if (noticeTimer !== undefined) {
      window.clearTimeout(noticeTimer)
      noticeTimer = undefined
    }
  }

  onScopeDispose(clearNotice)
  return { notice, showNotice, clearNotice }
}
