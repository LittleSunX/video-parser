import { createUpstreamAttempt, type Diagnostics } from '../utils/diagnostics'
import { AppError } from '../errors/app-error'
import type { VideoInfo } from '../types/video'
import { extractDouyinVideoId, MOBILE_USER_AGENT } from '../utils/url'
import type { VideoParser } from './base'
import type { ParsedMediaResult } from './douyin/types'
import { mapItemToVideoInfo } from './douyin/map-item'
import { findMediaItem, findFilterReason } from './douyin/items'
import { extractRouterData, pageMatchesExpectedVideo, extractMeta } from './douyin/page'
import { runParseStrategies } from './douyin/strategies'
import { normalizeText, normalizeUrl } from './douyin/text'

export class DouyinParser implements VideoParser {
  supports(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      return (
        hostname === 'douyin.com' ||
        hostname.endsWith('.douyin.com') ||
        hostname === 'iesdouyin.com' ||
        hostname.endsWith('.iesdouyin.com')
      )
    } catch {
      return false
    }
  }

  async parse(url: string, signal?: AbortSignal, trace?: Diagnostics): Promise<VideoInfo> {
    const sourceUrl = new URL(url)
    const videoId = extractDouyinVideoId(sourceUrl)

    if (!videoId) {
      throw new AppError('VIDEO_NOT_FOUND', '没有从链接中识别到抖音视频 ID')
    }

    const strategies = [
      {
        name: 'web-detail',
        run: (strategySignal: AbortSignal) =>
          this.parseFromWebDetail(videoId, sourceUrl, strategySignal, trace),
      },
      {
        name: 'mobile-feed',
        run: (strategySignal: AbortSignal) =>
          this.parseFromMobileFeed(videoId, sourceUrl, strategySignal, trace),
      },
      {
        name: 'mobile-ssr',
        run: (strategySignal: AbortSignal) =>
          this.parseFromMobileSsr(videoId, sourceUrl, strategySignal, trace),
      },
      {
        name: 'page-meta',
        run: (strategySignal: AbortSignal) =>
          this.parseFromCurrentPage(sourceUrl, videoId, strategySignal, trace),
      },
    ]

    return runParseStrategies(strategies, signal, trace)
  }

  private async parseFromWebDetail(
    videoId: string,
    sourceUrl: URL,
    signal?: AbortSignal,
    trace?: Diagnostics,
  ): Promise<ParsedMediaResult> {
    const endpoint =
      'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' +
      encodeURIComponent(videoId) +
      '&aid=6383'

    let lastError = 'Web Detail 未返回有效作品数据'

    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal?.throwIfAborted()
      const diagnostic = createUpstreamAttempt(
        trace,
        'web-detail',
        'web-detail',
        attempt + 1,
        signal,
      )
      try {
        const response = await diagnostic.response(() =>
          fetch(endpoint, {
            headers: buildWebDetailHeaders(),
            redirect: 'follow',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
              : AbortSignal.timeout(8000),
          }),
        )

        if (!response.ok) {
          diagnostic.result('http_error')
          lastError = 'HTTP ' + response.status
          continue
        }

        const text = await diagnostic.read(() => response.text())
        if (!text.trim()) {
          diagnostic.result('empty_response')
          lastError = '接口返回空响应'
          continue
        }

        const result = diagnostic.extract(() => {
          const data = JSON.parse(text) as unknown
          const item = findMediaItem(data, videoId)
          return item ? mapItemToVideoInfo(item, sourceUrl, videoId) : undefined
        })

        if (result) {
          diagnostic.result('success')
          return result
        }

        diagnostic.result('item_missing')
        lastError = '响应中没有目标作品数据'
      } catch (error) {
        diagnostic.fail(error)
        signal?.throwIfAborted()
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        diagnostic.finish()
      }
    }

    throw new AppError('PARSE_FAILED', 'Web Detail 解析失败：' + lastError, 422)
  }
  private async parseFromMobileSsr(
    videoId: string,
    sourceUrl: URL,
    signal?: AbortSignal,
    trace?: Diagnostics,
  ): Promise<ParsedMediaResult> {
    const candidates = [
      sourceUrl.toString(),
      'https://www.iesdouyin.com/share/video/' + videoId + '/',
      'https://www.iesdouyin.com/share/video/' + videoId + '/?app=aweme',
      'https://www.iesdouyin.com/share/video/' + videoId + '/?from_ssr=1',
      'https://www.iesdouyin.com/share/note/' + videoId + '/',
      'https://www.iesdouyin.com/share/slides/' + videoId + '/',
      'https://m.douyin.com/share/note/' + videoId,
    ]
    const endpointLabels = [
      'source-page',
      'share-video',
      'share-video-app',
      'share-video-ssr',
      'share-note',
      'share-slides',
      'mobile-note',
    ] as const

    let lastError: string | undefined

    for (const [index, candidate] of candidates.entries()) {
      signal?.throwIfAborted()
      const diagnostic = createUpstreamAttempt(
        trace,
        'mobile-ssr',
        endpointLabels[index],
        index + 1,
        signal,
      )
      try {
        const response = await diagnostic.response(() =>
          fetch(candidate, {
            method: 'GET',
            headers: buildPageHeaders(),
            redirect: 'follow',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
          }),
        )

        if (!response.ok) {
          diagnostic.result('http_error')
          lastError = 'HTTP ' + response.status
          continue
        }

        const html = await diagnostic.read(() => response.text())

        const result = diagnostic.extract(() => {
          if (!html || html.length < 1000) {
            diagnostic.result('page_too_small')
            lastError = '页面内容过少（' + html.length + ' 字节）'
            return
          }

          const routerData = extractRouterData(html)

          if (!routerData) {
            diagnostic.result('router_data_missing')
            lastError = '页面中未找到 _ROUTER_DATA'
            return
          }

          const item = findMediaItem(routerData, videoId)

          if (!item) {
            diagnostic.result('item_missing')
            const reason = findFilterReason(routerData)
            lastError = reason || '_ROUTER_DATA 中未找到目标作品 item'
            return
          }

          return mapItemToVideoInfo(item, sourceUrl, videoId)
        })
        if (result) {
          diagnostic.result('success')
          return result
        }
      } catch (error) {
        diagnostic.fail(error)
        signal?.throwIfAborted()
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        diagnostic.finish()
      }
    }

    throw new AppError('PARSE_FAILED', '移动端 SSR 解析失败：' + (lastError || '未知原因'), 422)
  }

  private async parseFromMobileFeed(
    videoId: string,
    sourceUrl: URL,
    signal?: AbortSignal,
    trace?: Diagnostics,
  ): Promise<ParsedMediaResult> {
    const endpoints = [
      'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=6383',
      'https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=1128',
      'https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=6383',
      'https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=' +
        encodeURIComponent(videoId) +
        '&aid=1128',
    ]
    const endpointLabels = [
      'feed-amemv-6383',
      'feed-amemv-1128',
      'feed-snssdk-6383',
      'feed-snssdk-1128',
    ] as const

    for (const [index, endpoint] of endpoints.entries()) {
      signal?.throwIfAborted()
      const diagnostic = createUpstreamAttempt(
        trace,
        'mobile-feed',
        endpointLabels[index],
        index + 1,
        signal,
      )
      try {
        const response = await diagnostic.response(() =>
          fetch(endpoint, {
            headers: {
              'User-Agent': MOBILE_USER_AGENT,
              Accept: 'application/json, text/plain, */*',
            },
            redirect: 'follow',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
              : AbortSignal.timeout(8000),
          }),
        )

        if (!response.ok) {
          diagnostic.result('http_error')
          continue
        }

        const data = await diagnostic.read(() => response.json() as Promise<unknown>)
        const result = diagnostic.extract(() => {
          const item = findMediaItem(data, videoId)
          return item ? mapItemToVideoInfo(item, sourceUrl, videoId) : undefined
        })

        if (result) {
          diagnostic.result('success')
          return result
        }
        diagnostic.result('item_missing')
      } catch (error) {
        diagnostic.fail(error)
        signal?.throwIfAborted()
        // 尝试备用移动端节点。
      } finally {
        diagnostic.finish()
      }
    }

    throw new AppError('PARSE_FAILED', '移动端视频详情接口未返回有效数据', 422)
  }

  private async parseFromCurrentPage(
    sourceUrl: URL,
    videoId: string,
    signal?: AbortSignal,
    trace?: Diagnostics,
  ): Promise<ParsedMediaResult> {
    const diagnostic = createUpstreamAttempt(trace, 'page-meta', 'current-page', 1, signal)
    try {
      const response = await diagnostic.response(() =>
        fetch(sourceUrl.toString(), {
          headers: buildPageHeaders(),
          redirect: 'follow',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
            : AbortSignal.timeout(8000),
        }),
      )

      if (!response.ok) {
        diagnostic.result('http_error')
        throw new AppError(
          'REQUEST_FAILED',
          '抖音视频页面请求失败（HTTP ' + response.status + '）',
          502,
        )
      }

      const html = await diagnostic.read(() => response.text())

      return diagnostic.extract(() => {
        if (!pageMatchesExpectedVideo(response.url, html, videoId)) {
          diagnostic.result('page_mismatch')
          throw new AppError('VIDEO_NOT_FOUND', '当前页面返回的视频 ID 与目标视频不一致', 422)
        }

        const title = extractMeta(html, 'og:title') ?? '抖音视频'
        const author = extractMeta(html, 'author') ?? undefined
        const cover = extractMeta(html, 'og:image') ?? undefined
        const videoUrl =
          extractMeta(html, 'og:video:secure_url') ??
          extractMeta(html, 'og:video') ??
          extractMeta(html, 'twitter:player:stream')

        if (!videoUrl) {
          diagnostic.result('resource_missing')
          throw new AppError(
            'VIDEO_RESOURCE_NOT_FOUND',
            '视频页面存在，但页面中没有可用的视频媒体地址',
            422,
          )
        }

        const result: ParsedMediaResult = {
          imagesComplete: true,
          video: {
            platform: 'douyin',
            mediaType: 'video',
            videoId,
            sourceUrl: sourceUrl.toString(),
            title: normalizeText(title),
            author: author ? normalizeText(author) : undefined,
            cover: cover ? normalizeUrl(cover) : undefined,
            videoUrl: normalizeUrl(videoUrl),
          },
        }
        diagnostic.result('success')
        return result
      })
    } catch (error) {
      diagnostic.fail(error)
      throw error
    } finally {
      diagnostic.finish()
    }
  }
}

function buildWebDetailHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Origin: 'https://open.douyin.com',
    Referer: 'https://open.douyin.com/',
  }
}

function buildPageHeaders(): Record<string, string> {
  return {
    'User-Agent': MOBILE_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.douyin.com/',
  }
}
