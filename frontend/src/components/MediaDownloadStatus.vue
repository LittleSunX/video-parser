<script setup lang="ts">
import type { FileDownload } from '../composables/useFileDownload'

defineProps<{ label: string; download: FileDownload; canReparse: boolean }>()
defineEmits<{ reparse: [] }>()
</script>

<template>
  <div
    v-if="download.status"
    class="download-status"
    :class="'download-status-' + download.state"
    role="status"
    aria-live="polite"
  >
    <strong v-if="download.state === 'handed-off'">✓ {{ label }}已交给浏览器保存</strong>
    <strong v-else-if="download.state === 'fallback'">已发起{{ label }}下载</strong>
    <strong v-else-if="download.state === 'failed'">{{ label }}下载失败</strong>
    <strong v-else-if="download.state === 'cancelled'">{{ label }}下载已取消</strong>
    <strong v-else>正在下载{{ label }}</strong>
    <span>{{ download.status }}</span>
    <progress
      v-if="download.downloading"
      class="download-progress"
      :value="download.progress"
      max="100"
      :aria-label="label + '下载进度'"
    />
    <button v-if="download.downloading" class="text-button" type="button" @click="download.cancel">
      取消{{ label }}下载
    </button>
    <button
      v-if="download.canSaveAgain"
      class="secondary-button"
      type="button"
      :disabled="download.bufferBusy"
      @click="download.saveAgain"
    >
      再次保存{{ label }}
    </button>
    <button
      v-if="!download.downloading && ['handed-off', 'failed'].includes(download.state)"
      class="secondary-button"
      type="button"
      :disabled="download.bufferBusy"
      @click="download.startBrowserDownload"
    >
      使用浏览器下载{{ label }}
    </button>
    <button
      v-if="download.needsReparse"
      class="secondary-button"
      type="button"
      :disabled="!canReparse"
      @click="$emit('reparse')"
    >
      重新解析后下载
    </button>
  </div>
</template>

<style scoped>
.download-progress {
  width: 100%;
  height: 8px;
  accent-color: #6366f1;
}
</style>
