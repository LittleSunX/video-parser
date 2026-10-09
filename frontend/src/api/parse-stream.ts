import type { VideoInfo } from '../types/video'
import { readVideoPayload } from './response'

const MAX_FRAME_LENGTH = 2 * 1024 * 1024
const MAX_STREAM_BYTES = 16 * 1024 * 1024
const protocolError = () => new Error('解析结果传输中断或格式异常，请重新解析')

/** 一个解析请求内先显示候选内容，必须收到最终结果才算成功。 */
export async function readParseStream(
  response: Response,
  signal?: AbortSignal,
  onPreview?: (video: VideoInfo) => void,
): Promise<VideoInfo> {
  if (!response.ok || !response.body) throw protocolError()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let bytes = 0
  const cancel = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', cancel, { once: true })

  function readFrame(line: string): VideoInfo | undefined {
    if (!line.trim()) return
    if (line.length > MAX_FRAME_LENGTH) throw protocolError()
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      throw protocolError()
    }
    if (!event || typeof event !== 'object') throw protocolError()
    if (event.type === 'error') {
      readVideoPayload({ success: false, error: event.error }, response)
      throw protocolError()
    }
    if (event.type !== 'preview' && event.type !== 'result') throw protocolError()
    const video = readVideoPayload({ success: true, data: event.data }, response)
    if (event.type === 'result') return video
    onPreview?.(video)
  }

  try {
    signal?.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read().catch(() => {
        signal?.throwIfAborted()
        throw protocolError()
      })
      signal?.throwIfAborted()
      if (value) bytes += value.byteLength
      if (bytes > MAX_STREAM_BYTES) throw protocolError()
      try {
        pending += decoder.decode(value, { stream: !done })
      } catch {
        throw protocolError()
      }
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const result = readFrame(line)
        signal?.throwIfAborted()
        if (result) return result
      }
      if (pending.length > MAX_FRAME_LENGTH) throw protocolError()
      if (done) {
        const result = readFrame(pending)
        signal?.throwIfAborted()
        if (result) return result
        throw protocolError()
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
