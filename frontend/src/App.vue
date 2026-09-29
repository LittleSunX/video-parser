<script setup lang="ts">
import type { VideoInfo } from './types/video'
import { formatDuration } from './utils/duration'
import { useVideoPage } from './composables/useVideoPage'
const {
  input,
  loading,
  errorMessage,
  video,
  notice,
  canSubmit,
  livePhotoCount,
  handleParse,
  cancelParse,
  handleClear,
  batchDownloading,
  batchProgress,
  videoDownloading,
  downloadStatus,
  downloadState,
  handleCopyVideoUrl,
  handleDownloadVideo,
  cancelVideoDownload,
  handleOpenVideoLink,
  handleProxyDownloadVideo,
  handleDownloadCover,
  handleDownloadImage,
  handleDownloadLivePhoto,
  handleDownloadAllPreferred,
  handleDownloadAllOriginals,
  stopBatchDownload,
  handleDownloadMusic,
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
              :disabled="batchDownloading"
              @click="handleDownloadLivePhoto(index)"
            >
              下载动态视频
            </button>
            <button
              v-if="asset.url"
              type="button"
              class="image-download-button"
              :disabled="batchDownloading"
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
            :disabled="batchDownloading"
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
            :disabled="batchDownloading"
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
            @click="handleDownloadCover"
          >
            下载封面
          </button>
          <button
            v-if="video.musicUrl"
            class="secondary-button"
            type="button"
            @click="handleDownloadMusic"
          >
            下载背景音乐
          </button>
          <a
            class="secondary-button"
            :href="video.sourceUrl"
            target="_blank"
            rel="noopener noreferrer"
            >查看原页面</a
          >
        </div>

        <p v-if="video.mediaType === 'image'" class="download-tip">
          批量下载保存为 ZIP，解压后查看视频和图片；总大小限 64 MB，超出请逐项下载。
        </p>
        <p v-if="video.mediaType === 'image' && batchProgress" class="download-tip" role="status">
          {{ batchProgress }}
        </p>
        <button
          v-if="batchDownloading"
          class="text-button"
          type="button"
          @click="stopBatchDownload"
        >
          停止发起后续下载
        </button>
        <p v-if="video.mediaType === 'image'" class="download-tip">
          批量下载需要浏览器允许多个文件下载；实际保存状态请查看浏览器下载列表。
        </p>
        <div
          v-if="video.mediaType === 'video' && downloadStatus"
          class="download-status"
          :class="'download-status-' + downloadState"
          role="status"
          aria-live="polite"
        >
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
