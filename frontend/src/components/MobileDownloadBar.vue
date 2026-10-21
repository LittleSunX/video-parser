<script setup lang="ts">
import AppIcon from './AppIcon.vue'

defineProps<{
  label: string
  summary: string
  disabled: boolean
  busy: boolean
  showTask: boolean
}>()
defineEmits<{ download: []; details: [] }>()
</script>

<template>
  <section class="mobile-download-bar" aria-label="快捷下载">
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
