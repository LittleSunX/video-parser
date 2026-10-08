<script setup lang="ts">
import type { VideoInfo } from './types/video'
import { formatDuration } from './utils/duration'
import { useVideoPage } from './composables/useVideoPage'
import MediaDownloadStatus from './components/MediaDownloadStatus.vue'
const {
  input,
  loading,
  errorMessage,
  video,
  notice,
  canSubmit,
  livePhotoCount,
  parseWarning,
  imageQualityNotice,
  handleParse,
  cancelParse,
  handleClear,
  batchDownloading,
  batchProgress,
  batchItems,
  batchCanRetry,
  batchHasCache,
  batchPart,
  batchCanContinue,
  saveBatchPart,
  continueBatchDownload,
  retryBatchDownload,
  videoDownloading,
  downloadStatus,
  downloadState,
  downloadNeedsReparse,
  handleCopyVideoUrl,
  handleDownloadVideo,
  cancelVideoDownload,
  handleOpenVideoLink,
  handleProxyDownloadVideo,
  coverDownload,
  handleDownloadImage,
  handleDownloadLivePhoto,
  handleDownloadAllPreferred,
  handleDownloadAllOriginals,
  stopBatchDownload,
  musicDownload,
} = useVideoPage()
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
        <button
          v-if="input"
          type="button"
          class="text-button"
          :disabled="loading"
          @click="handleClear"
        >
          清空
        </button>
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
      <button v-if="loading" class="secondary-button" type="button" @click="cancelParse">
        取消解析
      </button>
      <p class="hint">支持视频、图文和实况作品，Ctrl / ⌘ + Enter 可快速解析。</p>
    </section>

    <section v-if="errorMessage" class="message-card error-card" role="alert">
      <strong>解析失败</strong>
      <span>{{ errorMessage }}</span>
    </section>

    <section v-if="parseWarning" class="message-card warning-card" role="status">
      <strong>资源完整性尚未确认</strong>
      <span>{{ parseWarning }}</span>
      <button class="secondary-button" type="button" :disabled="!canSubmit" @click="handleParse">
        重新解析尝试补齐
      </button>
    </section>

    <section
      v-if="video"
      class="result-card"
      :class="{ 'image-result-card': video.mediaType === 'image' }"
    >
      <div v-if="video.mediaType === 'video'" class="cover-wrap">
        <img v-if="video.cover" :src="video.cover" :alt="video.title" class="cover" />
        <div v-else class="cover-placeholder">暂无封面</div>
        <span v-if="formatDuration(video.duration)" class="duration-badge">{{
          formatDuration(video.duration)
        }}</span>
      </div>

      <div v-else class="image-gallery">
        <article
          v-for="(asset, index) in video.images ?? []"
          :key="asset.url + (asset.livePhotoUrl ?? '')"
          class="image-card"
        >
          <div class="image-preview">
            <img v-if="asset.url" :src="asset.url" :alt="video.title + ' - ' + (index + 1)" />
            <div v-else class="cover-placeholder">实况视频</div>
            <span v-if="asset.livePhotoUrl" class="live-photo-badge">Live Photo</span>
          </div>
          <div class="image-card-actions">
            <button
              v-if="asset.livePhotoUrl"
              type="button"
              class="image-download-button primary-image-action"
              :disabled="batchDownloading || !!batchPart || batchCanContinue"
              @click="handleDownloadLivePhoto(index)"
            >
              下载动态视频
            </button>
            <button
              v-if="asset.url"
              type="button"
              class="image-download-button"
              :disabled="batchDownloading || !!batchPart || batchCanContinue"
              @click="handleDownloadImage(index)"
            >
              {{ asset.watermarkFree ? '下载无水印原图' : '下载高清原图' }}
            </button>
          </div>
        </article>
      </div>

      <div class="video-info">
        <div class="result-topline">
          <span class="platform-tag">{{ platformName(video.platform) }}</span>
          <span class="media-type-tag">{{
            video.mediaType === 'image' ? (livePhotoCount > 0 ? '实况图文' : '图文') : '视频'
          }}</span>
          <span class="video-id">ID {{ video.videoId }}</span>
        </div>

        <h2>{{ video.title }}</h2>
        <p v-if="video.author" class="meta">作者：{{ video.author }}</p>
        <p v-if="video.mediaType === 'image'" class="meta">
          共 {{ video.images?.length ?? 0 }} 项
          <template v-if="livePhotoCount > 0"> · {{ livePhotoCount }} 个动态实况</template>
        </p>
        <p v-if="video.musicTitle" class="meta">背景音乐：{{ video.musicTitle }}</p>
        <p v-if="imageQualityNotice" class="download-tip" role="status">{{ imageQualityNotice }}</p>

        <div class="actions">
          <button
            v-if="video.mediaType === 'video' && video.videoUrl"
            class="download-button"
            type="button"
            :disabled="videoDownloading"
            @click="handleDownloadVideo"
          >
            {{ videoDownloading ? '正在下载…' : '下载视频' }}
          </button>
          <button
            v-if="video.mediaType === 'video' && video.videoUrl"
            class="secondary-button"
            type="button"
            :disabled="videoDownloading"
            @click="handleProxyDownloadVideo"
          >
            备用下载
          </button>
          <button
            v-if="video.mediaType === 'video' && video.videoUrl"
            class="secondary-button"
            type="button"
            :disabled="videoDownloading"
            @click="handleOpenVideoLink"
          >
            打开直链
          </button>
          <button
            v-if="videoDownloading"
            class="text-button"
            type="button"
            @click="cancelVideoDownload"
          >
            取消下载
          </button>
          <button
            v-if="video.mediaType === 'image' && video.images?.length"
            class="download-button"
            type="button"
            :disabled="batchDownloading || !!batchPart || batchCanContinue"
            @click="handleDownloadAllPreferred"
          >
            {{
              livePhotoCount > 0
                ? '打包下载全部（动态优先）'
                : video.images?.every((asset) => asset.watermarkFree)
                  ? '打包下载全部无水印原图'
                  : '打包下载全部高清原图'
            }}
          </button>
          <button
            v-if="video.mediaType === 'image' && livePhotoCount > 0"
            class="secondary-button"
            type="button"
            :disabled="batchDownloading || !!batchPart || batchCanContinue"
            @click="handleDownloadAllOriginals"
          >
            打包下载全部原图
          </button>
          <button
            v-if="video.mediaType === 'video' && video.videoUrl"
            class="secondary-button"
            type="button"
            @click="handleCopyVideoUrl"
          >
            复制视频地址
          </button>
          <button
            v-if="video.mediaType === 'video' && video.cover"
            class="secondary-button"
            type="button"
            :disabled="coverDownload.downloading"
            @click="coverDownload.start"
          >
            {{ coverDownload.downloading ? '正在下载封面…' : '下载封面' }}
          </button>
          <button
            v-if="video.musicUrl"
            class="secondary-button"
            type="button"
            :disabled="musicDownload.downloading"
            @click="musicDownload.start"
          >
            {{ musicDownload.downloading ? '正在下载背景音乐…' : '下载背景音乐' }}
          </button>
          <a
            class="secondary-button"
            :href="video.sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
            >查看原页面</a
          >
        </div>

        <MediaDownloadStatus
          label="封面"
          :download="coverDownload"
          :can-reparse="canSubmit"
          @reparse="handleParse"
        />
        <MediaDownloadStatus
          label="背景音乐"
          :download="musicDownload"
          :can-reparse="canSubmit"
          @reparse="handleParse"
        />

        <p v-if="video.mediaType === 'image'" class="download-tip">
          批量下载保存为 ZIP，每包媒体内容最多 128 MB，超出会分包保存；单个文件超过 128 MB
          请逐项下载。
        </p>
        <p v-if="video.mediaType === 'image' && batchProgress" class="download-tip" role="status">
          {{ batchProgress }}
        </p>
        <button v-if="batchPart" class="download-button" type="button" @click="saveBatchPart">
          保存第 {{ batchPart.number }} 包（{{ batchPart.count }} 项，{{
            (batchPart.size / 1024 / 1024).toFixed(1)
          }}
          MB）
        </button>
        <button
          v-if="batchCanContinue"
          class="secondary-button"
          type="button"
          @click="continueBatchDownload"
        >
          继续准备下一包
        </button>
        <ol v-if="batchItems.length" class="download-tip" aria-label="批量文件状态">
          <li v-for="(item, index) in batchItems" :key="item.filename">
            第 {{ index + 1 }} 项：{{ item.message }}
          </li>
        </ol>
        <button
          v-if="batchCanRetry && !batchDownloading"
          class="secondary-button"
          type="button"
          @click="retryBatchDownload"
        >
          重试未完成项
        </button>
        <button
          v-if="(batchHasCache || batchCanContinue) && !batchDownloading"
          class="text-button"
          type="button"
          @click="stopBatchDownload"
        >
          结束批量任务并释放缓存
        </button>
        <button
          v-if="batchDownloading"
          class="text-button"
          type="button"
          @click="stopBatchDownload"
        >
          取消下载并释放缓存
        </button>
        <p v-if="video.mediaType === 'image'" class="download-tip">
          小作品自动保存一包；大作品请逐包点击保存，再继续下一包。中途失败可重试未完成项，实际保存状态请查看浏览器下载列表。
        </p>
        <div
          v-if="downloadStatus"
          class="download-status"
          :class="'download-status-' + downloadState"
          role="status"
          aria-live="polite"
        >
          <strong v-if="downloadState === 'handed-off'">✓ 视频已交给浏览器保存</strong>
          <strong v-else-if="downloadState === 'fallback'">已发起下载</strong>
          <strong v-else-if="downloadState === 'failed'">下载失败</strong>
          <strong v-else-if="downloadState === 'cancelled'">下载已取消</strong>
          <strong v-else>正在下载视频</strong>
          <span>{{ downloadStatus }}</span>
          <button
            v-if="downloadNeedsReparse"
            class="secondary-button"
            type="button"
            :disabled="!canSubmit"
            @click="handleParse"
          >
            重新解析后下载
          </button>
        </div>
        <p v-if="video.mediaType === 'video'" class="download-tip">
          点击下载后请保持页面打开，接收完成会自动请求保存。若浏览器未保存，可使用备用下载；打开直链则需从播放器菜单手动保存。
        </p>
        <p v-else class="download-tip">
          实况作品会优先提供 MP4 动态轨；只有明确命中无水印字段时才标记“无水印原图”，避免把普通 CDN
          图片误标为无水印。
        </p>
      </div>
    </section>

    <footer class="disclaimer">
      本工具仅用于公开内容的解析辅助，请遵守相关法律法规及平台规则。解析内容版权归原作者或相关权利人所有，请勿用于侵权传播、未经授权的商业用途或其他违法违规行为。因不当使用产生的相关责任由使用者自行承担。
    </footer>
  </main>
</template>
