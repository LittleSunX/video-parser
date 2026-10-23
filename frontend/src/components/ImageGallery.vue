<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ImageAsset } from '../types/video'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  images: ImageAsset[]
  title: string
  selectedIndex: number
  downloadDisabled: boolean
}>()
const emit = defineEmits<{
  'update:selectedIndex': [index: number]
  save: [index: number]
  saveLive: [index: number]
}>()
const view = ref<'single' | 'grid'>('single')
const selected = computed(() => props.images[props.selectedIndex])
const dialog = ref<HTMLDialogElement>()
const zoomed = ref(false)
const imageFailed = ref(false)
let previousOverflow = ''
let returnFocus: HTMLElement | null = null
let touchStart: { x: number; y: number } | undefined

watch(
  () => [props.selectedIndex, selected.value?.url],
  () => {
    imageFailed.value = false
  },
)
watch(
  () => props.images.length,
  (length) => {
    if (props.selectedIndex >= length) emit('update:selectedIndex', Math.max(0, length - 1))
    if (!length) closeZoom()
  },
)

function select(index: number) {
  emit('update:selectedIndex', Math.max(0, Math.min(props.images.length - 1, index)))
}
function selectTile(index: number) {
  select(index)
  view.value = 'single'
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    select(props.selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1))
  }
}
async function openZoom() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  zoomed.value = true
  await nextTick()
  if (!dialog.value || !zoomed.value) return
  previousOverflow = document.body.style.overflow
  dialog.value.showModal()
  document.body.style.overflow = 'hidden'
}
function closeZoom() {
  if (!zoomed.value) return
  zoomed.value = false
  dialog.value?.close()
  document.body.style.overflow = previousOverflow
  returnFocus?.focus()
}
function startSwipe(event: TouchEvent) {
  const touch = event.changedTouches[0]
  if (touch) touchStart = { x: touch.clientX, y: touch.clientY }
}
function endSwipe(event: TouchEvent) {
  const touch = event.changedTouches[0]
  if (touch && touchStart) {
    const dx = touch.clientX - touchStart.x
    const dy = touch.clientY - touchStart.y
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5)
      select(props.selectedIndex + (dx < 0 ? 1 : -1))
  }
  touchStart = undefined
}
onBeforeUnmount(closeZoom)
</script>

<template>
  <section class="image-gallery" aria-label="图文浏览" @keydown="onKeydown">
    <div class="gallery-toolbar">
      <span class="gallery-counter" aria-live="polite"
        >{{ String(selectedIndex + 1).padStart(2, '0') }}
        <span>/ {{ String(images.length).padStart(2, '0') }}</span></span
      >
      <div v-if="images.length > 1" class="view-switch" aria-label="浏览方式">
        <button type="button" :aria-pressed="view === 'single'" @click="view = 'single'">
          <AppIcon name="image" />大图
        </button>
        <button type="button" :aria-pressed="view === 'grid'" @click="view = 'grid'">
          <AppIcon name="grid" />总览
        </button>
      </div>
    </div>
    <template v-if="view === 'single' && selected">
      <div class="image-mat" @touchstart.passive="startSwipe" @touchend.passive="endSwipe">
        <button
          v-if="selected.url && !imageFailed"
          type="button"
          class="image-zoom-target"
          aria-label="放大查看当前图片"
          @click="openZoom"
        >
          <img
            :src="selected.url"
            :alt="title + ' · 第 ' + (selectedIndex + 1) + ' 张'"
            decoding="async"
            fetchpriority="high"
            @error="imageFailed = true"
          />
        </button>
        <div v-else class="media-placeholder">
          <AppIcon name="image" /><span>{{
            imageFailed ? '图片暂时无法预览，可尝试下载原图' : '仅动态资源，暂无静态预览'
          }}</span>
        </div>
        <span class="media-badge">{{
          selected.livePhotoUrl ? '含实况 · 静态预览' : '静态图片'
        }}</span>
        <button
          v-if="selected.url && !imageFailed"
          type="button"
          class="expand-button icon-button"
          aria-label="放大图片"
          @click="openZoom"
        >
          <AppIcon name="expand" />
        </button>
        <button
          v-if="images.length > 1"
          type="button"
          class="gallery-prev gallery-nav icon-button"
          aria-label="上一张图片"
          :disabled="selectedIndex === 0"
          @click="select(selectedIndex - 1)"
        >
          <AppIcon name="left" />
        </button>
        <button
          v-if="images.length > 1"
          type="button"
          class="gallery-next gallery-nav icon-button"
          aria-label="下一张图片"
          :disabled="selectedIndex === images.length - 1"
          @click="select(selectedIndex + 1)"
        >
          <AppIcon name="right" />
        </button>
      </div>
      <div class="image-caption">
        <span
          >第 {{ selectedIndex + 1 }} 张 ·
          {{ selected.livePhotoUrl ? '带动态实况' : '静态图片' }}</span
        >
        <div v-if="images.length > 1" class="image-save-actions">
          <button
            v-if="selected.url"
            type="button"
            class="text-button"
            :aria-label="
              '保存第 ' +
              (selectedIndex + 1) +
              ' 张' +
              (selected.watermarkFree ? '无水印原图' : '高清原图')
            "
            :disabled="downloadDisabled"
            @click="emit('save', selectedIndex)"
          >
            <AppIcon name="download" />{{ selected.watermarkFree ? '无水印原图' : '高清原图' }}
          </button>
          <button
            v-if="selected.livePhotoUrl"
            type="button"
            class="text-button"
            :aria-label="'保存第 ' + (selectedIndex + 1) + ' 项动态 MP4'"
            :disabled="downloadDisabled"
            @click="emit('saveLive', selectedIndex)"
          >
            <AppIcon name="film" />动态 MP4
          </button>
        </div>
      </div>
      <div v-if="images.length > 1" class="thumbnails" aria-label="选择图片">
        <button
          v-for="(asset, index) in images"
          :key="index"
          type="button"
          class="thumbnail"
          :aria-label="
            '第 ' + (index + 1) + ' 张，' + (asset.livePhotoUrl ? 'Live Photo' : '静态图片')
          "
          :aria-pressed="selectedIndex === index"
          @click="select(index)"
        >
          <img v-if="asset.url" :src="asset.url" alt="" loading="lazy" decoding="async" /><AppIcon
            v-else
            name="film"
          />
          <span><AppIcon v-if="asset.livePhotoUrl" name="live" />{{ index + 1 }}</span>
        </button>
      </div>
    </template>
    <div v-else class="contact-sheet" aria-label="全部图片">
      <button
        v-for="(asset, index) in images"
        :key="index"
        type="button"
        class="contact-item"
        :aria-label="'查看第 ' + (index + 1) + ' 张' + (asset.livePhotoUrl ? '实况图片' : '图片')"
        :aria-pressed="selectedIndex === index"
        @click="selectTile(index)"
      >
        <img
          v-if="asset.url"
          :src="asset.url"
          :alt="'第 ' + (index + 1) + ' 张'"
          loading="lazy"
          decoding="async"
        /><span v-else class="contact-placeholder"><AppIcon name="film" />实况视频</span>
        <span
          ><span>{{ String(index + 1).padStart(2, '0') }}</span
          ><span>{{ asset.livePhotoUrl ? 'Live Photo' : '静态图片' }}</span></span
        >
      </button>
    </div>
    <Teleport to="body">
      <dialog
        ref="dialog"
        class="image-dialog"
        aria-label="图片放大预览"
        @close="closeZoom"
        @cancel.prevent="closeZoom"
        @click.self="closeZoom"
        @keydown="onKeydown"
      >
        <template v-if="zoomed && selected">
          <div class="dialog-header">
            <span aria-live="polite"
              >第 {{ selectedIndex + 1 }} / {{ images.length }} 张 ·
              {{ selected.livePhotoUrl ? 'Live Photo' : '静态图片' }}</span
            ><button
              type="button"
              class="icon-button"
              aria-label="关闭放大预览"
              autofocus
              @click="closeZoom"
            >
              <AppIcon name="close" />
            </button>
          </div>
          <div class="dialog-media" @touchstart.passive="startSwipe" @touchend.passive="endSwipe">
            <img
              v-if="selected.url && !imageFailed"
              :src="selected.url"
              :alt="title + ' · 第 ' + (selectedIndex + 1) + ' 张'"
              @error="imageFailed = true"
            />
            <div v-else class="media-placeholder">
              <AppIcon name="image" /><span>暂无静态预览，可关闭预览后下载</span>
            </div>
            <button
              v-if="images.length > 1"
              type="button"
              class="gallery-prev gallery-nav icon-button"
              aria-label="上一张图片"
              :disabled="selectedIndex === 0"
              @click="select(selectedIndex - 1)"
            >
              <AppIcon name="left" />
            </button>
            <button
              v-if="images.length > 1"
              type="button"
              class="gallery-next gallery-nav icon-button"
              aria-label="下一张图片"
              :disabled="selectedIndex === images.length - 1"
              @click="select(selectedIndex + 1)"
            >
              <AppIcon name="right" />
            </button>
          </div>
          <p class="dialog-hint">左右切换图片 · Esc 关闭</p>
        </template>
      </dialog>
    </Teleport>
  </section>
</template>
