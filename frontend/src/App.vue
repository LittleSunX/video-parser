<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { VideoInfo } from './types/video'
import { formatDuration } from './utils/duration'
import { imageSaveSummary, presentTitle } from './utils/presentation'
import { useVideoPage } from './composables/useVideoPage'
import AppIcon from './components/AppIcon.vue'
import ImageGallery from './components/ImageGallery.vue'
import WorkTitle from './components/WorkTitle.vue'
import MobileDownloadBar from './components/MobileDownloadBar.vue'
import DownloadTask from './components/DownloadTask.vue'
import MediaDownloadStatus from './components/MediaDownloadStatus.vue'
const {
  input,
  loading,
  errorMessage,
  errorDiagnostics,
  copyingProblemInfo,
  copyProblemInfo,
  video,
  previewing,
  notice,
  canSubmit,
  livePhotoCount,
  preferredDownloadCount,
  originalDownloadCount,
  preferredDownloadLabel,
  originalDownloadLabel,
  hasArchiveDownloads,
  parseWarning,
  imageQualityNotice,
  handleParse,
  cancelParse,
  handleClear,
  bufferBusy,
  canSaveVideoAgain,
  saveVideoAgain,
  canSaveBatchAgain,
  saveBatchAgain,
  batchPartLimitMiB,
  batchDownloading,
  batchProgress,
  batchItems,
  batchCanRetry,
  batchFailed,
  pendingBatch,
  batchHasCache,
  batchPart,
  batchCanContinue,
  saveBatchPart,
  continueBatchDownload,
  retryBatchDownload,
  videoDownloading,
  downloadStatus,
  downloadLabel,
  downloadState,
  downloadNeedsReparse,
  handleCopyVideoUrl,
  handleDownloadVideo,
  cancelVideoDownload,
  handleOpenVideoLink,
  handleProxyDownloadVideo,
  coverDownload,
  imageDownload,
  imageDownloadName,
  handleDownloadImage,
  handleDownloadLivePhoto,
  handleDownloadAllPreferred,
  handleDownloadAllOriginals,
  stopBatchDownload,
  musicDownload,
} = useVideoPage()

const selectedIndex = ref(0)
const saveMode = ref<'motion' | 'stills'>('motion')
const inputElement = ref<HTMLTextAreaElement>()
const editingInput = ref(false)
const saveOptionsElement = ref<HTMLElement>()
const primarySaveElement = ref<HTMLElement>()
const transferElement = ref<HTMLElement>()
const coverFailed = ref(false)
const title = computed(() => presentTitle(video.value?.title ?? ''))

const imageSaveDisabled = computed(
  () => loading.value || bufferBusy.value || batchDownloading.value || pendingBatch.value,
)
const saveCount = computed(() =>
  saveMode.value === 'motion' ? preferredDownloadCount.value : originalDownloadCount.value,
)
const saveSummary = computed(() => imageSaveSummary(video.value, saveMode.value === 'motion'))
const saveLabel = computed(() => {
  if (batchDownloading.value) return '正在准备文件…'
  if (saveCount.value > 1) return '打包下载全部'
  return saveMode.value === 'motion' ? preferredDownloadLabel.value : originalDownloadLabel.value
})
const mediaLabel = computed(() =>
  video.value?.mediaType === 'image' ? (livePhotoCount.value ? '实况图文' : '图文') : '视频',
)
const downloadBusy = computed(
  () => bufferBusy.value || batchDownloading.value || videoDownloading.value,
)
const mobileShowsTask = computed(
  () =>
    downloadBusy.value ||
    pendingBatch.value ||
    batchFailed.value ||
    downloadState.value === 'failed' ||
    [imageDownload, coverDownload, musicDownload].some((download) => download.state === 'failed'),
)
const mobileAction = computed(() => {
  const disabled = loading.value || downloadBusy.value
  if (batchPart.value)
    return { label: `保存第 ${batchPart.value.number} 包`, disabled, run: saveBatchPart }
  if (batchCanContinue.value) return { label: '继续下一包', disabled, run: continueBatchDownload }
  if (batchCanRetry.value) return { label: '重试未完成项', disabled, run: retryBatchDownload }
  if (batchFailed.value) return { label: '查看下载问题', disabled, run: showDownloadDetails }
  if (video.value?.mediaType === 'image')
    return {
      label: saveLabel.value,
      disabled: disabled || imageSaveDisabled.value || !saveCount.value,
      run: saveAll,
    }
  return {
    label: '下载视频',
    disabled: disabled || !video.value?.videoUrl,
    run: handleDownloadVideo,
  }
})
const mobileLabel = computed(() =>
  loading.value
    ? '正在检查资源…'
    : downloadBusy.value
      ? batchDownloading.value
        ? '正在准备文件…'
        : '正在下载…'
      : mobileAction.value.label,
)
const mobileSummary = computed(() => {
  if (loading.value) return '资源检查完成后即可下载'
  if (batchPart.value)
    return `第 ${batchPart.value.number} 包已就绪 · ${batchPart.value.count} 项文件`
  if (batchCanContinue.value) return '上一包已请求保存，可继续下载'
  if (downloadBusy.value) return '下载进行中，请保持页面打开'
  if (batchFailed.value) return '打包未完成，请查看下载任务'
  return video.value?.mediaType === 'image'
    ? saveSummary.value || '暂无可下载资源'
    : ['视频', formatDuration(video.value?.duration)].filter(Boolean).join(' · ')
})
function showDownloadDetails() {
  const target =
    mobileShowsTask.value && transferElement.value
      ? transferElement.value
      : saveOptionsElement.value
  target?.scrollIntoView({ block: 'start' })
  target?.focus({ preventScroll: true })
}
watch(
  () => video.value?.cover,
  () => {
    coverFailed.value = false
  },
)
watch(
  () => video.value?.videoId,
  () => {
    selectedIndex.value = 0
    saveMode.value = 'motion'
  },
)
watch(
  () => video.value?.images?.length ?? 0,
  (length) => {
    selectedIndex.value = Math.max(0, Math.min(selectedIndex.value, length - 1))
  },
)
function resizeInput() {
  const element = inputElement.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = Math.min(126, element.scrollHeight) + 'px'
}
watch(input, async () => {
  await nextTick()
  resizeInput()
})
onMounted(() => window.addEventListener('resize', resizeInput))
onBeforeUnmount(() => window.removeEventListener('resize', resizeInput))
function submitOnEnter(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void handleParse()
}
function saveAll() {
  return saveMode.value === 'motion' ? handleDownloadAllPreferred() : handleDownloadAllOriginals()
}
function platformName(platform: VideoInfo['platform']) {
  const names: Record<VideoInfo['platform'], string> = {
    douyin: '抖音',
    kuaishou: '快手',
    xiaohongshu: '小红书',
    tiktok: 'TikTok',
    unknown: '未知平台',
  }
  return names[platform]
}
</script>

<template>
  <main class="page-shell" :class="{ 'has-download-bar': video && !editingInput }">
    <Transition name="toast">
      <div v-if="notice" class="toast-message" role="status">{{ notice }}</div>
    </Transition>

    <header class="hero">
      <div>
        <span class="eyebrow">视频 · 图文 · 实况下载</span>
        <h1>留住<span>一闪而过</span>的喜欢。</h1>
      </div>
      <span class="platform-support"><span />当前支持抖音</span>
    </header>

    <form class="parser-form" :aria-busy="loading" @submit.prevent="handleParse">
      <label class="sr-only" for="share-link">分享链接或分享文案</label>
      <div class="input-row">
        <AppIcon name="link" />
        <textarea
          id="share-link"
          ref="inputElement"
          v-model="input"
          rows="1"
          placeholder="粘贴抖音分享链接或文案"
          :disabled="loading"
          @focus="editingInput = true"
          @blur="editingInput = false"
          @keydown="submitOnEnter"
        />
        <button
          v-if="input && !loading"
          type="button"
          class="clear-input icon-button"
          aria-label="清空链接与解析结果"
          @click="handleClear"
        >
          <AppIcon name="close" />
        </button>
        <button class="parse-button" type="submit" :disabled="!canSubmit">
          <span v-if="loading" class="button-spinner" aria-hidden="true" /><span>{{
            loading ? '正在解析' : '解析链接'
          }}</span
          ><AppIcon v-if="!loading" name="arrow" />
        </button>
      </div>
      <div v-if="loading" class="parse-progress" role="status">
        <span>{{
          previewing ? '已找到作品，正在检查资源与画质…' : '正在寻找这份作品，请稍候…'
        }}</span
        ><button type="button" class="text-button" @click="cancelParse">取消解析</button>
      </div>
      <p v-else-if="!video && !errorMessage" class="input-hint">
        支持完整分享文案，按 Enter 解析，Shift + Enter 换行。
      </p>
    </form>

    <section v-if="errorMessage" class="message-card error-card" role="alert">
      <strong>暂时没能解析这份作品</strong><span>{{ errorMessage }}</span>
      <div class="inline-actions">
        <button class="secondary-button" type="button" :disabled="!canSubmit" @click="handleParse">
          重试解析
        </button>
        <button
          v-if="errorDiagnostics"
          class="text-button"
          type="button"
          :disabled="loading || copyingProblemInfo"
          @click="copyProblemInfo"
        >
          {{ copyingProblemInfo ? '正在复制…' : '复制问题信息' }}
        </button>
      </div>
      <small v-if="errorDiagnostics">问题信息不包含分享文案与媒体地址。</small>
    </section>
    <section v-if="parseWarning" class="message-card warning-card" role="status">
      <strong>资源完整性尚未确认</strong><span>{{ parseWarning }}</span>
      <button class="text-button" type="button" :disabled="!canSubmit" @click="handleParse">
        重新解析尝试补齐<AppIcon name="arrow" />
      </button>
    </section>

    <section v-if="video" class="result-card" aria-label="解析结果">
      <ImageGallery
        v-if="video.mediaType === 'image' && video.images?.length"
        :key="video.videoId"
        v-model:selected-index="selectedIndex"
        :images="video.images"
        :title="title.text"
        :download-disabled="imageSaveDisabled"
        @save="handleDownloadImage"
        @save-live="handleDownloadLivePhoto"
      />
      <section v-else class="video-gallery" aria-label="视频封面">
        <div class="gallery-toolbar">
          <span class="gallery-counter">01 <span>/ VIDEO</span></span
          ><span class="gallery-caption">视频封面</span>
        </div>
        <div class="video-mat">
          <img
            v-if="video.cover && !coverFailed"
            :src="video.cover"
            :alt="title.text"
            class="video-cover"
            decoding="async"
            fetchpriority="high"
            @error="coverFailed = true"
          />
          <div v-else class="media-placeholder">
            <AppIcon name="film" /><span>暂无封面，可直接下载视频</span>
          </div>
        </div>
        <div class="image-caption">
          <span>{{ platformName(video.platform) }} · {{ mediaLabel }}</span
          ><span v-if="formatDuration(video.duration)">{{ formatDuration(video.duration) }}</span>
        </div>
      </section>

      <section class="work-details" aria-label="作品信息与保存选项">
        <div class="result-status" role="status">
          <span :class="{ 'status-loading': previewing }" />{{
            previewing
              ? '正在检查资源与画质'
              : parseWarning
                ? '可用资源已就绪'
                : mediaLabel + '已就绪'
          }}
        </div>
        <div class="work-heading">
          <WorkTitle :text="title.text" />
          <p v-if="video.author" class="author">@ {{ video.author }}</p>
        </div>
        <div v-if="title.tags.length" class="work-tags">
          <span v-for="tag in title.tags" :key="tag">{{ tag }}</span>
        </div>
        <div v-if="video.mediaType !== 'image'" class="work-meta">
          <span><AppIcon name="film" />{{ platformName(video.platform) }}视频</span>
          <span v-if="formatDuration(video.duration)">{{ formatDuration(video.duration) }}</span>
        </div>
        <p v-if="previewing" class="download-tip">画质与资源检查完成后即可下载。</p>

        <div
          v-if="video.mediaType === 'image'"
          ref="saveOptionsElement"
          class="save-options image-save-options"
          tabindex="-1"
        >
          <span class="section-label">{{
            (video.images?.length ?? 0) > 1 ? '整组保存' : '保存格式'
          }}</span>
          <div v-if="livePhotoCount > 0" class="format-switch" aria-label="整组下载内容">
            <button
              type="button"
              :aria-pressed="saveMode === 'motion'"
              :disabled="imageSaveDisabled"
              @click="saveMode = 'motion'"
            >
              <AppIcon name="live" />保留动态
            </button>
            <button
              type="button"
              :aria-pressed="saveMode === 'stills'"
              :disabled="imageSaveDisabled || !originalDownloadCount"
              @click="saveMode = 'stills'"
            >
              <AppIcon name="image" />仅存原图
            </button>
          </div>
          <p class="format-summary" aria-live="polite">{{ saveSummary || '暂无可下载资源' }}</p>
          <button
            v-if="saveCount"
            ref="primarySaveElement"
            class="download-button"
            type="button"
            :disabled="imageSaveDisabled"
            @click="saveAll"
          >
            <span>{{ saveLabel }}</span
            ><AppIcon name="download" />
          </button>
          <p v-if="livePhotoCount > 0" class="download-tip">
            {{
              saveMode === 'motion'
                ? '实况内容将保存为 MP4 视频文件'
                : '仅保存静态图片，不包含动态部分'
            }}
          </p>

          <p v-if="imageQualityNotice" class="quality-note" role="status">
            {{ imageQualityNotice }}
          </p>
        </div>

        <div v-else ref="saveOptionsElement" class="save-options" tabindex="-1">
          <span class="section-label">保存这份作品</span>
          <button
            v-if="video.videoUrl"
            ref="primarySaveElement"
            class="download-button"
            type="button"
            :disabled="loading || bufferBusy || videoDownloading"
            @click="handleDownloadVideo"
          >
            <span>{{ videoDownloading ? '正在下载…' : '下载视频' }}</span
            ><AppIcon name="download" />
          </button>
          <div class="inline-actions secondary-downloads">
            <button
              v-if="video.cover"
              class="text-button"
              type="button"
              :disabled="imageSaveDisabled"
              @click="coverDownload.start"
            >
              <AppIcon name="image" />{{ coverDownload.downloading ? '正在下载封面…' : '下载封面' }}
            </button>
            <button
              v-if="video.videoUrl"
              class="text-button"
              type="button"
              :disabled="loading"
              @click="handleCopyVideoUrl"
            >
              <AppIcon name="copy" />复制视频地址
            </button>
          </div>
          <details
            v-if="video.videoUrl"
            class="alternate-downloads"
            :open="downloadState === 'failed'"
          >
            <summary>备用下载与直链</summary>
            <div class="inline-actions">
              <button
                class="secondary-button"
                type="button"
                :disabled="loading || bufferBusy || videoDownloading"
                @click="handleProxyDownloadVideo"
              >
                备用下载
              </button>
              <button
                class="secondary-button"
                type="button"
                :disabled="loading"
                @click="handleOpenVideoLink"
              >
                打开直链<AppIcon name="arrow" />
              </button>
            </div>
          </details>
        </div>

        <section
          v-if="
            downloadStatus ||
            coverDownload.status ||
            imageDownload.status ||
            musicDownload.status ||
            batchProgress ||
            batchItems.length ||
            batchPart ||
            canSaveBatchAgain ||
            batchCanContinue
          "
          class="transfer-panel"
          ref="transferElement"
          tabindex="-1"
          aria-label="下载任务"
        >
          <MediaDownloadStatus
            label="封面"
            :download="coverDownload"
            :actions-disabled="loading || pendingBatch"
            :can-reparse="canSubmit"
            @reparse="handleParse"
          />
          <MediaDownloadStatus
            :label="imageDownloadName"
            :download="imageDownload"
            :actions-disabled="loading || pendingBatch"
            :can-reparse="canSubmit"
            @reparse="handleParse"
          />
          <MediaDownloadStatus
            label="背景音乐"
            :download="musicDownload"
            :actions-disabled="loading || pendingBatch"
            :can-reparse="canSubmit"
            @reparse="handleParse"
          />
          <DownloadTask
            v-if="
              batchProgress ||
              batchItems.length ||
              batchPart ||
              canSaveBatchAgain ||
              batchCanContinue
            "
            :heading="
              batchDownloading
                ? '正在准备打包文件'
                : batchPart
                  ? '这一包已准备好'
                  : batchCanContinue
                    ? '可以继续准备下一包'
                    : batchFailed
                      ? '打包未完成'
                      : '打包下载进度'
            "
            :message="batchProgress"
            :busy="batchDownloading"
            :state="batchFailed ? 'failed' : undefined"
          >
            <template #actions>
              <button
                v-if="batchPart"
                class="task-primary"
                type="button"
                :disabled="loading || bufferBusy"
                @click="saveBatchPart"
              >
                保存第 {{ batchPart.number }} 包（{{ batchPart.count }} 项，{{
                  (batchPart.size / 1024 / 1024).toFixed(1)
                }}
                MB）
              </button>
              <button
                v-if="canSaveBatchAgain && !batchPart"
                class="text-button"
                type="button"
                :disabled="loading || bufferBusy"
                @click="saveBatchAgain"
              >
                再次保存 ZIP
              </button>
              <button
                v-if="batchCanContinue"
                class="task-primary"
                type="button"
                :disabled="loading || bufferBusy"
                @click="continueBatchDownload"
              >
                继续准备下一包
              </button>
              <button
                v-if="batchCanRetry && !batchDownloading"
                class="text-button"
                type="button"
                :disabled="loading || bufferBusy"
                @click="retryBatchDownload"
              >
                重试未完成项
              </button>
              <button
                v-if="(batchHasCache || batchCanContinue || batchFailed) && !batchDownloading"
                class="text-button task-dismiss"
                type="button"
                @click="stopBatchDownload"
              >
                结束任务
              </button>
              <button
                v-if="batchDownloading"
                class="text-button task-dismiss"
                type="button"
                @click="stopBatchDownload"
              >
                取消下载
              </button>
            </template>
            <details v-if="batchItems.length" class="task-details">
              <summary>文件明细 · {{ batchItems.length }} 项</summary>
              <ol class="task-files" aria-label="批量文件状态">
                <li v-for="(item, index) in batchItems" :key="item.filename">
                  第 {{ index + 1 }} 项：{{ item.message }}
                </li>
              </ol>
            </details>
          </DownloadTask>
          <DownloadTask
            v-if="downloadStatus"
            :heading="
              downloadState === 'handed-off'
                ? downloadLabel + '已交给浏览器保存'
                : downloadState === 'fallback'
                  ? '已发起' + downloadLabel + '下载'
                  : downloadState === 'failed'
                    ? downloadLabel + '下载失败'
                    : downloadState === 'cancelled'
                      ? downloadLabel + '下载已取消'
                      : '正在下载' + downloadLabel
            "
            :message="downloadStatus"
            :state="downloadState"
            :busy="videoDownloading"
          >
            <template #actions>
              <button
                v-if="canSaveVideoAgain"
                class="text-button"
                type="button"
                :disabled="loading || bufferBusy"
                @click="saveVideoAgain"
              >
                再次保存{{ downloadLabel }}
              </button>
              <button
                v-if="downloadNeedsReparse"
                class="text-button"
                type="button"
                :disabled="!canSubmit"
                @click="handleParse"
              >
                重新解析
              </button>
              <button
                v-if="videoDownloading"
                class="text-button task-dismiss"
                type="button"
                @click="cancelVideoDownload"
              >
                取消下载
              </button>
            </template>
          </DownloadTask>
        </section>

        <button
          v-if="video.musicUrl"
          class="music-download"
          type="button"
          :disabled="imageSaveDisabled || musicDownload.downloading"
          @click="musicDownload.start"
        >
          <span class="music-icon"><AppIcon name="music" /></span
          ><span
            ><small>{{ musicDownload.downloading ? '正在下载背景音乐…' : '背景音乐' }}</small
            ><span>{{ video.musicTitle || '作品背景音乐' }}</span></span
          ><AppIcon name="download" />
        </button>
        <a
          class="original-link text-button"
          :href="video.sourceUrl"
          target="_blank"
          rel="noopener noreferrer"
          >查看原作品<AppIcon name="arrow"
        /></a>
        <details class="download-help">
          <summary>下载说明</summary>
          <p class="download-tip">
            下载时请保持页面打开，接收完成会自动请求保存。若浏览器未保存，可在 30
            秒内再次保存；开始新下载会释放上一份暂存。实际保存状态请查看浏览器下载列表。
          </p>
          <p v-if="video.mediaType === 'video'" class="download-tip">
            下载遇到问题可使用备用下载；打开直链需从播放器菜单手动保存。
          </p>
          <template v-else>
            <p v-if="hasArchiveDownloads" class="download-tip">
              批量下载保存为 ZIP，每包媒体内容最多 {{ batchPartLimitMiB }} MB，超出会分包保存；
              单个文件超过 {{ batchPartLimitMiB }} MB 请逐项下载。小作品自动保存一包；
              大作品请逐包点击保存，再继续下一包。中途失败可重试未完成项。
            </p>
            <p class="download-tip">
              实况作品优先提供 MP4 动态视频；静态图片会区分“无水印原图”和“高清原图”。
              只有来源明确提供无水印图片时，才会标记“无水印原图”。
            </p>
          </template>
        </details>
      </section>
    </section>

    <section
      v-else-if="!errorMessage"
      class="empty-state"
      :class="{ 'is-loading': loading }"
      :aria-busy="loading"
      aria-label="支持的内容类型"
    >
      <div class="empty-heading">
        <h2>{{ loading ? '正在解析链接…' : '粘贴链接，选择内容，下载保存。' }}</h2>
        <p>
          {{
            loading
              ? '解析期间可以取消，结果准备好后会显示在这里。'
              : '支持视频、图文和实况，分享文案也可以直接粘贴。'
          }}
        </p>
      </div>
      <div class="content-types">
        <div>
          <AppIcon name="film" /><span>视频</span>
          <p>视频、封面与音乐</p>
        </div>
        <div>
          <AppIcon name="image" /><span>图文</span>
          <p>单张保存，整组打包</p>
        </div>
        <div>
          <AppIcon name="live" /><span>实况</span>
          <p>原图或动态视频</p>
        </div>
      </div>
    </section>

    <MobileDownloadBar
      v-if="video && !editingInput"
      :label="mobileLabel"
      :summary="mobileSummary"
      :disabled="mobileAction.disabled"
      :busy="loading || downloadBusy"
      :show-task="mobileShowsTask"
      :action-element="primarySaveElement"
      @download="mobileAction.run"
      @details="showDownloadDetails"
    />

    <footer class="page-footer">
      <details>
        <summary>使用与版权说明</summary>
        <p>
          本工具仅用于公开内容的解析辅助，请遵守相关法律法规及平台规则。解析内容版权归原作者或相关权利人所有，请勿用于侵权传播、未经授权的商业用途或其他违法违规行为。因不当使用产生的相关责任由使用者自行承担。
        </p>
      </details>
    </footer>
  </main>
</template>
