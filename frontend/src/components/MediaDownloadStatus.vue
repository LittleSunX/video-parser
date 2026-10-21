<script setup lang="ts">
import { computed } from 'vue'
import type { FileDownload } from '../composables/useFileDownload'
import DownloadTask from './DownloadTask.vue'

const props = defineProps<{
  label: string
  download: FileDownload
  canReparse: boolean
  actionsDisabled?: boolean
}>()
defineEmits<{ reparse: [] }>()
const heading = computed(() => {
  const { label, download } = props
  if (download.state === 'handed-off') return label + '已交给浏览器保存'
  if (download.state === 'fallback') return '已发起' + label + '下载'
  if (download.state === 'failed') return label + '下载失败'
  if (download.state === 'cancelled') return label + '下载已取消'
  return '正在下载' + label
})
</script>

<template>
  <DownloadTask
    v-if="download.status"
    :heading="heading"
    :message="download.status"
    :state="download.state"
    :busy="download.downloading"
    :progress="download.progress"
  >
    <template #actions>
      <button
        v-if="download.downloading"
        class="text-button"
        type="button"
        @click="download.cancel"
      >
        取消下载
      </button>
      <button
        v-if="download.canSaveAgain"
        class="text-button"
        type="button"
        :disabled="actionsDisabled || download.bufferBusy"
        @click="download.saveAgain"
      >
        再次保存{{ label }}
      </button>
      <button
        v-if="download.needsReparse"
        class="text-button"
        type="button"
        :disabled="!canReparse"
        @click="$emit('reparse')"
      >
        重新解析
      </button>
      <button
        v-if="!download.downloading && download.state === 'failed'"
        class="text-button"
        type="button"
        :disabled="actionsDisabled || download.bufferBusy"
        @click="download.startBrowserDownload"
      >
        使用浏览器下载
      </button>
    </template>
    <details v-if="!download.downloading && download.state === 'handed-off'" class="task-details">
      <summary>浏览器没有保存？</summary>
      <button
        class="text-button"
        type="button"
        :disabled="actionsDisabled || download.bufferBusy"
        @click="download.startBrowserDownload"
      >
        使用浏览器下载{{ label }}
      </button>
    </details>
  </DownloadTask>
</template>
