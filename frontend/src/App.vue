<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { parseVideo } from './api/video'
import type { VideoInfo } from './types/video'
import { formatDuration } from './utils/duration'
import { downloadDirectVideo } from './utils/auto-download'
import {
  buildCoverFilename,
  buildImageFilename,
  buildLivePhotoFilename,
  buildMusicFilename,
  buildVideoFilename,
  copyText,
  openDirectDownload,
  triggerDownload,
} from './utils/download'

const input = ref('')
const loading = ref(false)
const errorMessage = ref('')
const video = ref<VideoInfo | null>(null)
const notice = ref('')
const batchDownloading = ref(false)
const batchProgress = ref('')
const videoDownloading = ref(false)
const downloadStatus = ref('')
const downloadState = ref<'receiving' | 'handed-off' | 'fallback' | 'cancelled'>('receiving')
let downloadController: AbortController | undefined
let parseController: AbortController | undefined
let batchController: AbortController | undefined

let noticeTimer: number | undefined

const canSubmit = computed(() => input.value.trim().length > 0 && !loading.value)
const livePhotoCount = computed(() =>
  video.value?.images?.filter((image) => !!image.livePhotoUrl).length ?? 0,
)

async function handleParse() {
  if (!canSubmit.value) return

  stopBatchDownload()
  cancelVideoDownload()
  downloadStatus.value = ''
  const controller = new AbortController()
  parseController = controller
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException('解析超时', 'TimeoutError'))
  }, 35000)
  loading.value = true
  errorMessage.value = ''
  video.value = null
  clearNotice()

  try {
    const result = await parseVideo(input.value.trim(), controller.signal)
    if (parseController !== controller || controller.signal.aborted) return
    video.value = result
    if (video.value.mediaType === 'image' && livePhotoCount.value > 0) {
      showNotice('实况图文解析成功')
    } else {
      showNotice(video.value.mediaType === 'image' ? '图文解析成功' : '视频解析成功')
    }
  } catch (error) {
    if (parseController !== controller) return
    errorMessage.value = controller.signal.aborted
      ? (controller.signal.reason?.name === 'TimeoutError' ? '解析超时，请重试' : '')
      : error instanceof Error ? error.message : '作品解析失败，请稍后重试'
  } finally {
    window.clearTimeout(timeout)
    if (parseController === controller) {
      parseController = undefined
      loading.value = false
    }
  }
}

function cancelParse() {
  parseController?.abort()
  parseController = undefined
  loading.value = false
  showNotice('已取消解析')
}

function handleClear() {
  stopBatchDownload()
  cancelVideoDownload()
  downloadStatus.value = ''
  input.value = ''
  video.value = null
  errorMessage.value = ''
  clearNotice()
}

async function handleCopyVideoUrl() {
  if (!video.value?.videoUrl) return
  try {
    await copyText(video.value.videoUrl)
    showNotice('视频地址已复制')
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '复制失败')
  }
}

async function handleDownloadVideo() {
  const current = video.value
  if (!current?.videoUrl || videoDownloading.value) return
  const controller = new AbortController()
  downloadController = controller
  videoDownloading.value = true
  downloadState.value = 'receiving'
  downloadStatus.value = '正在连接下载…'
  try {
    await downloadDirectVideo(current.videoUrl, buildVideoFilename(current), {
      signal: controller.signal,
      onProgress(received, total) {
        if (downloadController !== controller) return
        downloadStatus.value = total
          ? '正在下载 ' + Math.min(100, Math.round(received / total * 100)) + '%'
          : '已接收 ' + (received / 1024 / 1024).toFixed(1) + ' MB'
      },
    })
    if (downloadController !== controller) return
    downloadState.value = 'handed-off'
    downloadStatus.value = '已请求浏览器保存，请查看下载列表；若未保存，可使用备用下载。'
    showNotice('视频已交给浏览器保存，请查看下载列表', 6000)
  } catch {
    if (controller.signal.aborted || downloadController !== controller) return
    triggerDownload(current.videoUrl, buildVideoFilename(current))
    downloadState.value = 'fallback'
    showNotice('已切换备用下载，请查看浏览器下载列表', 6000)
    downloadStatus.value = '已切换到备用下载，请查看浏览器下载列表；速度较慢时可使用“打开直链”。'
  } finally {
    if (downloadController === controller) {
      downloadController = undefined
      videoDownloading.value = false
    }
  }
}

function cancelVideoDownload() {
  downloadController?.abort()
  downloadController = undefined
  videoDownloading.value = false
  downloadState.value = 'cancelled'
  downloadStatus.value = '已取消下载'
}

function handleOpenVideoLink() {
  if (!video.value?.videoUrl) return
  openDirectDownload(video.value.videoUrl)
}

function handleProxyDownloadVideo() {
  if (!video.value?.videoUrl || videoDownloading.value) return
  triggerDownload(video.value.videoUrl, buildVideoFilename(video.value))
  downloadState.value = 'fallback'
  downloadStatus.value = '已发起备用下载，请查看浏览器下载列表。'
  showNotice('已发起备用下载，请查看浏览器下载列表', 6000)
}

function handleDownloadCover() {
  if (!video.value?.cover) return
  triggerDownload(video.value.cover, buildCoverFilename(video.value))
  showNotice('已发起封面下载')
}

function handleDownloadImage(index: number) {
  const current = video.value
  const asset = current?.images?.[index]
  if (!current || !asset?.url) return
  triggerDownload(asset.url, buildImageFilename(current, index))
  showNotice(
    asset.watermarkFree
      ? '已发起第 ' + (index + 1) + ' 张无水印原图下载'
      : '已发起第 ' + (index + 1) + ' 张高清原图下载',
  )
}

function handleDownloadLivePhoto(index: number) {
  const current = video.value
  const asset = current?.images?.[index]
  if (!current || !asset?.livePhotoUrl) return
  triggerDownload(asset.livePhotoUrl, buildLivePhotoFilename(current, index))
  showNotice('已发起第 ' + (index + 1) + ' 个实况视频下载')
}

function handleDownloadAllPreferred() {
  return handleBatchDownload(true)
}

function handleDownloadAllOriginals() {
  return handleBatchDownload(false)
}

function stopBatchDownload() {
  batchController?.abort()
  batchController = undefined
  batchDownloading.value = false
  batchProgress.value = ''
}

async function handleBatchDownload(preferLive: boolean) {
  if (batchDownloading.value) return
  const current = video.value
  if (!current?.images?.length) return
  const jobs = current.images.flatMap((asset, index) => {
    if (preferLive && asset.livePhotoUrl) {
      return [{ url: asset.livePhotoUrl, filename: buildLivePhotoFilename(current, index) }]
    }
    return asset.url ? [{ url: asset.url, filename: buildImageFilename(current, index) }] : []
  })
  if (!jobs.length) return

  const controller = new AbortController()
  batchController = controller
  batchDownloading.value = true
  try {
    for (let index = 0; index < jobs.length; index += 1) {
      if (controller.signal.aborted) return
      triggerDownload(jobs[index].url, jobs[index].filename)
      batchProgress.value = '已发起 ' + (index + 1) + ' / ' + jobs.length + ' 个下载请求'
      if (index < jobs.length - 1) await delay(300)
    }
    showNotice('已发起全部下载，请在浏览器下载列表中查看；如有提示，请允许多个文件下载')
  } catch {
    showNotice('批量下载中断，请检查浏览器下载列表后重试')
  } finally {
    if (batchController === controller) {
      batchController = undefined
      batchDownloading.value = false
    }
  }
}

function handleDownloadMusic() {
  const current = video.value
  if (!current?.musicUrl) return
  triggerDownload(current.musicUrl, buildMusicFilename(current))
  showNotice('已发起背景音乐下载')
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
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

onBeforeUnmount(() => {
  parseController?.abort()
  parseController = undefined
  stopBatchDownload()
  cancelVideoDownload()
  clearNotice()
})
</script>

<template>
  <main class="page-shell">
    <Transition name="toast">
      <div v-if="notice" class="toast-message" role="status">{{ notice }}</div>
    </Transition>

    <section class="hero">
      <span class="eyebrow">VIDEO PARSER</span>
      <h1>短视频解析下载</h1>
      <p class="subtitle">粘贴分享链接，解析视频、图文和 Live Photo 实况资源。当前支持抖音。</p>
    </section>

    <section class="parser-card">
      <div class="input-heading">
        <label class="input-label" for="share-link">分享链接或分享文案</label>
        <button v-if="input" type="button" class="text-button" :disabled="loading" @click="handleClear">清空</button>
      </div>
      <textarea
        id="share-link"
        v-model="input"
        class="url-input"
        rows="4"
        placeholder="例如：复制打开抖音…… https://v.douyin.com/xxxx/"
        :disabled="loading"
        @keydown.ctrl.enter="handleParse"
        @keydown.meta.enter="handleParse"
      />
      <button class="primary-button" type="button" :disabled="!canSubmit" @click="handleParse">
        <span v-if="loading" class="button-spinner" aria-hidden="true" />
        {{ loading ? '正在解析...' : '开始解析' }}
      </button>
      <button v-if="loading" class="secondary-button" type="button" @click="cancelParse">取消解析</button>
      <p class="hint">支持视频、图文和实况作品，Ctrl / ⌘ + Enter 可快速解析。</p>
    </section>

    <section v-if="errorMessage" class="message-card error-card" role="alert">
      <strong>解析失败</strong>
      <span>{{ errorMessage }}</span>
    </section>

    <section v-if="video" class="result-card" :class="{ 'image-result-card': video.mediaType === 'image' }">
      <div v-if="video.mediaType === 'video'" class="cover-wrap">
        <img v-if="video.cover" :src="video.cover" :alt="video.title" class="cover" />
        <div v-else class="cover-placeholder">暂无封面</div>
        <span v-if="formatDuration(video.duration)" class="duration-badge">{{ formatDuration(video.duration) }}</span>
      </div>

      <div v-else class="image-gallery">
        <article v-for="(asset, index) in video.images ?? []" :key="asset.url + (asset.livePhotoUrl ?? '')" class="image-card">
          <div class="image-preview">
            <img v-if="asset.url" :src="asset.url" :alt="video.title + ' - ' + (index + 1)" />
            <div v-else class="cover-placeholder">实况视频</div>
            <span v-if="asset.livePhotoUrl" class="live-photo-badge">Live Photo</span>
          </div>
          <div class="image-card-actions">
            <button v-if="asset.livePhotoUrl" type="button" class="image-download-button primary-image-action" :disabled="batchDownloading" @click="handleDownloadLivePhoto(index)">下载动态视频</button>
            <button v-if="asset.url" type="button" class="image-download-button" :disabled="batchDownloading" @click="handleDownloadImage(index)">
              {{ asset.watermarkFree ? '下载无水印原图' : '下载高清原图' }}
            </button>
          </div>
        </article>
      </div>

      <div class="video-info">
        <div class="result-topline">
          <span class="platform-tag">{{ platformName(video.platform) }}</span>
          <span class="media-type-tag">{{ video.mediaType === 'image' ? (livePhotoCount > 0 ? '实况图文' : '图文') : '视频' }}</span>
          <span class="video-id">ID {{ video.videoId }}</span>
        </div>

        <h2>{{ video.title }}</h2>
        <p v-if="video.author" class="meta">作者：{{ video.author }}</p>
        <p v-if="video.mediaType === 'image'" class="meta">
          共 {{ video.images?.length ?? 0 }} 项
          <template v-if="livePhotoCount > 0"> · {{ livePhotoCount }} 个动态实况</template>
        </p>
        <p v-if="video.musicTitle" class="meta">背景音乐：{{ video.musicTitle }}</p>

        <div class="actions">
          <button v-if="video.mediaType === 'video' && video.videoUrl" class="download-button" type="button" :disabled="videoDownloading" @click="handleDownloadVideo">{{ videoDownloading ? '正在下载…' : '下载视频' }}</button>
          <button v-if="video.mediaType === 'video' && video.videoUrl" class="secondary-button" type="button" :disabled="videoDownloading" @click="handleProxyDownloadVideo">备用下载</button>
          <button v-if="video.mediaType === 'video' && video.videoUrl" class="secondary-button" type="button" :disabled="videoDownloading" @click="handleOpenVideoLink">打开直链</button>
          <button v-if="videoDownloading" class="text-button" type="button" @click="cancelVideoDownload">取消下载</button>
          <button v-if="video.mediaType === 'image' && video.images?.length" class="download-button" type="button" :disabled="batchDownloading" @click="handleDownloadAllPreferred">
            {{ livePhotoCount > 0
              ? '优先下载全部动态视频'
              : (video.images?.every((asset) => asset.watermarkFree)
                ? '下载全部无水印原图'
                : '下载全部高清原图') }}
          </button>
          <button v-if="video.mediaType === 'image' && livePhotoCount > 0" class="secondary-button" type="button" :disabled="batchDownloading" @click="handleDownloadAllOriginals">下载全部原图</button>
          <button v-if="video.mediaType === 'video' && video.videoUrl" class="secondary-button" type="button" @click="handleCopyVideoUrl">复制视频地址</button>
          <button v-if="video.mediaType === 'video' && video.cover" class="secondary-button" type="button" @click="handleDownloadCover">下载封面</button>
          <button v-if="video.musicUrl" class="secondary-button" type="button" @click="handleDownloadMusic">下载背景音乐</button>
          <a class="secondary-button" :href="video.sourceUrl" target="_blank" rel="noopener noreferrer">查看原页面</a>
        </div>

        <p v-if="video.mediaType === 'image' && batchProgress" class="download-tip" role="status">{{ batchProgress }}</p>
        <button v-if="batchDownloading" class="text-button" type="button" @click="stopBatchDownload">停止发起后续下载</button>
        <p v-if="video.mediaType === 'image'" class="download-tip">批量下载需要浏览器允许多个文件下载；实际保存状态请查看浏览器下载列表。</p>
        <div v-if="video.mediaType === 'video' && downloadStatus" class="download-status" :class="'download-status-' + downloadState" role="status" aria-live="polite">
          <strong v-if="downloadState === 'handed-off'">✓ 视频已交给浏览器保存</strong>
          <strong v-else-if="downloadState === 'fallback'">已发起备用下载</strong>
          <strong v-else-if="downloadState === 'cancelled'">下载已取消</strong>
          <strong v-else>正在下载视频</strong>
          <span>{{ downloadStatus }}</span>
        </div>
        <p v-if="video.mediaType === 'video'" class="download-tip">
          点击下载后请保持页面打开，接收完成会自动请求保存。若浏览器未保存，可使用备用下载；打开直链则需从播放器菜单手动保存。
        </p>
        <p v-else class="download-tip">
          实况作品会优先提供 MP4 动态轨；只有明确命中无水印字段时才标记“无水印原图”，避免把普通 CDN 图片误标为无水印。
        </p>
      </div>
    </section>

    <footer class="disclaimer">
      本工具仅用于公开内容的解析辅助，请遵守相关法律法规及平台规则。解析内容版权归原作者或相关权利人所有，请勿用于侵权传播、未经授权的商业用途或其他违法违规行为。因不当使用产生的相关责任由使用者自行承担。
    </footer>
  </main>
</template>
