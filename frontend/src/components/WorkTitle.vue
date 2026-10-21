<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ text: string }>()
const heading = ref<HTMLHeadingElement>()
const expanded = ref(false)
const canExpand = ref(false)
let observer: ResizeObserver | undefined

function measure() {
  if (heading.value && !expanded.value)
    canExpand.value = heading.value.scrollHeight > heading.value.clientHeight + 1
}
async function toggle() {
  expanded.value = !expanded.value
  await nextTick()
  measure()
}
watch(
  () => props.text,
  async () => {
    expanded.value = false
    await nextTick()
    measure()
  },
)
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    if (heading.value) observer.observe(heading.value)
  }
  window.addEventListener('resize', measure)
  measure()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <div class="work-title">
    <h2 id="work-title" ref="heading" :class="{ 'title-clamped': !expanded }">{{ text }}</h2>
    <button
      v-if="canExpand"
      type="button"
      class="text-button title-toggle"
      :aria-expanded="expanded"
      aria-controls="work-title"
      @click="toggle"
    >
      {{ expanded ? '收起' : '展开' }}
    </button>
  </div>
</template>
