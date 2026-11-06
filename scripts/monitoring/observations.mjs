import { createLogSummary } from '../diagnostics-summary.mjs'

const versionId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value)

/** Journal JSON and raw NDJSON are both supported; output never contains original records. */
export async function observeLogs(
  stream,
  { now, windowSeconds, maxBytes = 64 * 1024 * 1024, maxRequests = 100000 } = {},
) {
  const groups = new Map()
  const requests = new Set()
  const since = now - windowSeconds * 1000
  let pending = '',
    bytes = 0,
    accepted = 0,
    ignored = 0
  function add(line) {
    let record, at
    try {
      record = JSON.parse(line)
      if (typeof record.MESSAGE === 'string') {
        at = Number(record.__REALTIME_TIMESTAMP) / 1000
        record = JSON.parse(record.MESSAGE)
      } else at = Date.parse(record.timestamp)
    } catch {
      ignored++
      return
    }
    if (
      !Number.isFinite(at) ||
      at < since ||
      at > now ||
      !versionId(record?.version) ||
      !['node', 'cloudflare-worker'].includes(record?.runtime)
    ) {
      ignored++
      return
    }
    let group = groups.get(record.version)
    if (!group) group = createLogSummary({ maxRequests })
    if (!group.add(JSON.stringify(record))) {
      ignored++
      return
    }
    // Count version + request identity; reused IDs across versions cannot bypass the global bound.
    requests.add(record.version + ':' + record.requestId)
    if (requests.size > maxRequests) throw new Error('Too many requests in monitoring window')
    if (!groups.has(record.version)) {
      if (groups.size >= 16) throw new Error('Too many versions in monitoring window')
      groups.set(record.version, group)
    }
    accepted++
  }
  stream.setEncoding('utf8')
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > maxBytes) throw new Error('Monitor log input exceeds limit')
    pending += chunk
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end)
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Monitor log line exceeds limit')
      if (line.trim()) add(line)
      pending = pending.slice(end + 1)
    }
    if (Buffer.byteLength(pending) > 64 * 1024) throw new Error('Monitor log line exceeds limit')
  }
  if (pending.trim()) add(pending)
  // A running API emits health request diagnostics even with no business traffic.
  if (!accepted) return { ok: false, reason: 'no_usable_records', versions: {}, accepted, ignored }
  return {
    ok: true,
    versions: Object.fromEntries([...groups].map(([id, group]) => [id, group.finish()])),
    accepted,
    ignored,
  }
}

export async function probeHealth(url, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response, reader
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    })
    if (response.status !== 200 || !response.body) return { ok: false, reason: 'http_error' }
    reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16384) return { ok: false, reason: 'invalid_response' }
      chunks.push(Buffer.from(value))
    }
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const data = json?.data
    if (
      json.success !== true ||
      data?.service !== 'video-parser-api' ||
      data.status !== 'ok' ||
      !['node', 'cloudflare-worker'].includes(data.runtime) ||
      !versionId(data.version) ||
      data.version === 'unknown'
    )
      return { ok: false, reason: 'invalid_response' }
    return {
      ok: true,
      runtime: data.runtime,
      version: data.version,
      ...(/^[a-f0-9]{40}$/i.test(data.versionTag ?? '') ? { commit: data.versionTag } : {}),
    }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unavailable' }
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    } else void response?.body?.cancel().catch(() => {})
  }
}
