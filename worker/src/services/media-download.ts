import { AppError } from '../errors/app-error'

const MEDIA_HOST_SUFFIXES = [
  'douyinvod.com',
  'douyinpic.com',
  'douyinstatic.com',
  'douyin.com',
  'iesdouyin.com',
  'byteimg.com',
  'bytecdn.cn',
  'bytedance.com',
  'snssdk.com',
  'amemv.com',
  'zjcdn.com',
  'volccdn.com',
  'byteicdn.com',
  'bytefcdnrd.com',
  'ibytedtos.com',
  'pstatp.com',
  'bytegecko.com',
]

// 仅限制响应头等待和单次读取停滞，不限制持续传输的大文件总时长。
const RESPONSE_TIMEOUT_MS = 15000
const READ_TIMEOUT_MS = 30000

export async function fetchMedia(
  initialUrl: URL,
  range: string | null,
  clientSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const cancel = () => controller.abort(new AppError('DOWNLOAD_CANCELLED', '下载已取消', 499))
  if (clientSignal.aborted) cancel()
  else clientSignal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(
    () => controller.abort(new AppError('DOWNLOAD_TIMEOUT', '等待媒体响应超时', 504)),
    RESPONSE_TIMEOUT_MS,
  )
  const cleanup = () => {
    clearTimeout(timer)
    clientSignal.removeEventListener('abort', cancel)
  }
  let upstream: Response | undefined
  try {
    let current = initialUrl
    for (let index = 0; index < 6; index++) {
      controller.signal.throwIfAborted()
      validateMediaUrl(current)
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.douyin.com/',
        Accept: '*/*',
      }
      if (range) headers.Range = range
      upstream = await fetch(current.toString(), {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      })
      controller.signal.throwIfAborted()
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break
      const location = upstream.headers.get('Location')
      if (!location) throw new AppError('DOWNLOAD_FAILED', '媒体重定向缺少地址', 502)
      await upstream.body?.cancel()
      upstream = undefined
      current = new URL(location, current)
    }
    if (!upstream) throw new AppError('DOWNLOAD_FAILED', '媒体资源重定向次数过多', 502)
    if ([401, 403, 404, 410].includes(upstream.status)) {
      throw new AppError('MEDIA_UNAVAILABLE', 'Media HTTP ' + upstream.status, 422)
    }
    if (upstream.status === 429) throw new AppError('UPSTREAM_BUSY', 'Media HTTP 429', 503)
    if (!upstream.ok && upstream.status !== 206) {
      throw new AppError('DOWNLOAD_FAILED', '媒体资源下载失败（HTTP ' + upstream.status + '）', 502)
    }

    if (!upstream.body) throw new AppError('DOWNLOAD_FAILED', '媒体响应为空', 502)
    clearTimeout(timer)
    const body = guardMediaStream(upstream.body, controller, cleanup)
    return new Response(body, { status: upstream.status, headers: upstream.headers })
  } catch (error) {
    cleanup()
    const reason = controller.signal.aborted ? controller.signal.reason : error
    controller.abort(reason)
    void upstream?.body?.cancel().catch(() => {})
    if (reason instanceof AppError) throw reason
    throw new AppError('DOWNLOAD_NETWORK_ERROR', '媒体网络连接失败', 502)
  }
}

function guardMediaStream(
  body: ReadableStream<Uint8Array>,
  abortController: AbortController,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let output: ReadableStreamDefaultController<Uint8Array>
  const finish = () => {
    ended = true
    clearTimeout(timer)
    cleanup()
    abortController.signal.removeEventListener('abort', onAbort)
  }
  const stopReader = () => {
    void reader
      .cancel()
      .catch(() => {})
      .finally(() => reader.releaseLock())
  }
  const onAbort = () => {
    if (ended) return
    finish()
    output.error(abortController.signal.reason)
    stopReader()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      abortController.signal.addEventListener('abort', onAbort, { once: true })
      if (abortController.signal.aborted) onAbort()
    },
    async pull(controller) {
      if (ended) return
      // 只在等待上游数据时计时，浏览器背压暂停读取不算上游停滞。
      timer = setTimeout(
        () => abortController.abort(new AppError('DOWNLOAD_TIMEOUT', '媒体读取超时', 504)),
        READ_TIMEOUT_MS,
      )
      try {
        const { done, value } = await reader.read()
        clearTimeout(timer)
        if (ended) return
        if (done) {
          finish()
          reader.releaseLock()
          controller.close()
        } else controller.enqueue(value)
      } catch {
        if (!ended)
          abortController.abort(new AppError('DOWNLOAD_NETWORK_ERROR', '媒体传输中断', 502))
      }
    },
    cancel() {
      if (ended) return
      finish()
      abortController.abort(new AppError('DOWNLOAD_CANCELLED', '下载已取消', 499))
      stopReader()
    },
  })
}

function validateMediaUrl(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new AppError('INVALID_URL', '仅支持 HTTPS 媒体地址')
  }

  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('INVALID_URL', '链接不能包含登录信息或自定义端口')
  }

  const hostname = url.hostname.toLowerCase()
  const allowed = MEDIA_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith('.' + suffix),
  )

  if (!allowed) {
    throw new AppError('INVALID_URL', '该媒体地址不在允许的下载域名中')
  }
}
