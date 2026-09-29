import { Zip, ZipPassThrough } from 'fflate'

/** 分块读取 Blob 并构造 ZIP，避免整包 Uint8Array 及其额外复制。 */
export async function createMediaArchive(
  files: Map<string, Blob>,
  signal: AbortSignal,
): Promise<Blob> {
  const chunks: Blob[] = []
  let failure: Error | null = null
  let complete = false
  const zip = new Zip((error, data, final) => {
    if (error) failure = error
    else {
      if (data.byteLength) chunks.push(new Blob([new Uint8Array(data).buffer]))
      complete = final
    }
  })
  try {
    for (const [filename, blob] of files) {
      signal.throwIfAborted()
      const entry = new ZipPassThrough(filename)
      zip.add(entry)
      // 定长切片避免依赖不同浏览器 Blob.stream() 的分块大小。
      for (let offset = 0; offset < blob.size; offset += 256 * 1024) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 256 * 1024).arrayBuffer())
        signal.throwIfAborted()
        entry.push(bytes, offset + bytes.byteLength === blob.size)
        if (failure) throw failure
      }
      if (!blob.size) entry.push(new Uint8Array(), true)
    }
    zip.end()
    if (failure) throw failure
    if (!complete) throw new Error('打包未完成，请重试')
    signal.throwIfAborted()
    return new Blob(chunks, { type: 'application/zip' })
  } finally {
    zip.terminate()
    chunks.length = 0
  }
}
