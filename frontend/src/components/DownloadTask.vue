<script setup lang="ts">
import AppIcon from './AppIcon.vue'

defineProps<{
  heading: string
  message: string
  state?: string
  busy?: boolean
  progress?: number
}>()
</script>

<template>
  <article class="download-task" :class="{ 'is-failed': state === 'failed' }">
    <div class="task-heading" role="status" aria-live="polite">
      <span v-if="busy" class="button-spinner" aria-hidden="true" />
      <AppIcon v-else :name="state === 'handed-off' ? 'check' : 'download'" />
      <strong>{{ heading }}</strong>
    </div>
    <p class="task-message" role="status" aria-live="polite">{{ message }}</p>
    <progress
      v-if="busy"
      class="download-progress"
      :value="progress"
      max="100"
      aria-label="下载进度"
    />
    <div v-if="$slots.actions" class="task-actions"><slot name="actions" /></div>
    <slot />
  </article>
</template>
