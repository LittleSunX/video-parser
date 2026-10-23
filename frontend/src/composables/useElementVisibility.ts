import { ref, watch, type Ref } from 'vue'

/** Keep the fallback action available until its inline counterpart is fully visible. */
export function useElementVisibility(target: Readonly<Ref<HTMLElement | undefined>>) {
  const visible = ref(false)
  watch(
    target,
    (element, _previous, onCleanup) => {
      visible.value = false
      if (!element || typeof IntersectionObserver === 'undefined') return
      let active = true
      const observer = new IntersectionObserver(
        (entries) => {
          if (!active) return
          for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index]
            if (entry.target !== element) continue
            visible.value = entry.isIntersecting && entry.intersectionRatio >= 1
            break
          }
        },
        { threshold: [0, 1] },
      )
      observer.observe(element)
      onCleanup(() => {
        active = false
        observer.disconnect()
      })
    },
    { immediate: true, flush: 'post' },
  )
  return visible
}
