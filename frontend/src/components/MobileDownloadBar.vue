<script setup lang="ts">
import { ref, toRef, watch } from 'vue'
import { useElementVisibility } from '../composables/useElementVisibility'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  label: string
  summary: string
  disabled: boolean
  busy: boolean
  showTask: boolean
  actionElement?: HTMLElement
}>()
defineEmits<{ download: []; details: [] }>()
const barElement = ref<HTMLElement>()
const inlineActionVisible = useElementVisibility(toRef(props, 'actionElement'))
watch(
  () => !props.showTask && inlineActionVisible.value,
  (hidden) => {
    if (hidden && barElement.value?.contains(document.activeElement)) {
      props.actionElement?.focus({ preventScroll: true })
    }
  },
)
</script>

<template>
  <section
    v-show="showTask || !inlineActionVisible"
    ref="barElement"
    class="mobile-download-bar"
    aria-label="快捷下载"
  >
    <div class="mobile-download-inner">
      <p class="mobile-download-summary">{{ summary }}</p>
      <div class="mobile-download-actions">
        <button type="button" class="secondary-button" @click="$emit('details')">
          {{ showTask ? '查看任务' : '下载选项' }}
        </button>
        <button
          type="button"
          class="download-button"
          :disabled="disabled"
          @click="$emit('download')"
        >
          <span>{{ label }}</span>
          <span v-if="busy" class="button-spinner" aria-hidden="true" />
          <AppIcon v-else name="download" />
        </button>
      </div>
    </div>
  </section>
</template>
