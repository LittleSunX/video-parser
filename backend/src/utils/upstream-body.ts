import { AppError } from '../errors/app-error'

/** HTML/JSON only: media downloads have their own streaming policy. */
export const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024

/** Enforce the decoded byte budget even without a trustworthy Content-Length. */
export async function readUpstreamText(
  response: Response,
  signal?: AbortSignal,
  maxBytes = MAX_UPSTREAM_BODY_BYTES,
): Promise<string> {
  const reader = response.body?.getReader()
  let complete = false
  const tooLarge = () => new AppError('UPSTREAM_RESPONSE_TOO_LARGE', '上游解析内容过大', 502)
  try {
    signal?.throwIfAborted()
    const encoding = response.headers.get('Content-Encoding')?.trim().toLowerCase()
    const length = Number(response.headers.get('Content-Length'))
    if ((!encoding || encoding === 'identity') && length > maxBytes) throw tooLarge()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ''
    while (true) {
      const { done, value } = await abortableRead(reader, signal)
      signal?.throwIfAborted()
      if (done) {
        complete = true
        return text + decoder.decode()
      }
      bytes += value.byteLength
      if (bytes > maxBytes) throw tooLarge()
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    // Remote cancellation may never finish. It must not block another strategy.
    if (reader) {
      if (!complete) void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

function abortableRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}
