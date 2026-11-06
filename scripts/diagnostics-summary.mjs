const strategies = ['web-detail', 'mobile-feed', 'mobile-ssr', 'page-meta']
const events = new Set([
  'request_response',
  'request_error',
  'resolve_complete',
  'parse_first_usable',
  'parse_selection',
  'parse_stream_complete',
  'upstream_attempt',
  'download_transfer',
])
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const requestId = (value) =>
  typeof value === 'string' &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)

function distribution(values) {
  values.sort((a, b) => a - b)
  const percentile = (p) => (values.length ? values[Math.ceil(values.length * p) - 1] : null)
  return { samples: values.length, p50: percentile(0.5), p95: percentile(0.95) }
}

/** Request IDs are only used for correlation; output contains fixed labels and aggregates. */
export function createLogSummary({ maxRequests = 100_000, version } = {}) {
  const requests = new Map()
  let ignoredLines = 0
  let duplicateEvents = 0
  function add(line) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      ignoredLines++
      return
    }
    if (
      !event ||
      !events.has(event.event) ||
      !requestId(event.requestId) ||
      (version !== undefined && event.version !== version)
    ) {
      ignoredLines++
      return
    }
    let request = requests.get(event.requestId)
    if (!request) {
      if (requests.size >= maxRequests) throw new Error('Too many requests; split the input log')
      request = { attempts: new Map() }
      requests.set(event.requestId, request)
    }
    if (event.event === 'upstream_attempt') {
      if (
        !strategies.includes(event.strategy) ||
        !Number.isSafeInteger(event.attempt) ||
        event.attempt < 1 ||
        event.attempt > 100 ||
        typeof event.endpoint !== 'string' ||
        !/^[a-z0-9-]{1,40}$/.test(event.endpoint)
      ) {
        ignoredLines++
        return
      }
      const key = `${event.strategy}:${event.endpoint}:${event.attempt}`
      if (request.attempts.has(key)) {
        duplicateEvents++
        return true
      }
      request.parse = true
      request.attempts.set(key, {
        strategy: event.strategy,
        success: event.result === 'success',
        cancelled: event.result === 'cancelled',
        rateLimited: event.status === 429,
        forbidden: event.status === 403,
        timeout: event.result === 'timeout',
        durationMs: finite(event.durationMs) ? event.durationMs : undefined,
      })
      return true
    }
    if (request[event.event]) {
      duplicateEvents++
      return true
    }
    // Retain only fields needed for aggregation, never the complete original record.
    request[event.event] = {
      operation: ['parse', 'download', 'other'].includes(event.operation)
        ? event.operation
        : undefined,
      status:
        Number.isInteger(event.status) && event.status >= 100 && event.status <= 599
          ? event.status
          : undefined,
      outcome: ['success', 'error', 'cancelled'].includes(event.outcome)
        ? event.outcome
        : undefined,
      reason: ['complete', 'exhausted', 'timeout', 'cancelled'].includes(event.reason)
        ? event.reason
        : undefined,
      sinceRequestMs: finite(event.sinceRequestMs) ? event.sinceRequestMs : undefined,
      cancelled: event.code === 'REQUEST_CANCELLED' || event.code === 'CANCELLED',
      bytes: finite(event.bytes) ? event.bytes : 0,
    }
    if (
      [
        'resolve_complete',
        'parse_first_usable',
        'parse_selection',
        'parse_stream_complete',
      ].includes(event.event) ||
      (event.event === 'request_response' && event.operation === 'parse' && event.status !== 204)
    )
      request.parse = true
    return true
  }

  function finish() {
    const parse = {
      observed: 0,
      complete: 0,
      unverified: 0,
      failed: 0,
      cancelled: 0,
      unfinished: 0,
      serverErrors: 0,
    }
    const first = [],
      final = []
    const upstream = Object.fromEntries(
      strategies.map((name) => [
        name,
        {
          attempts: 0,
          successes: 0,
          cancelled: 0,
          rateLimited: 0,
          forbidden: 0,
          timeouts: 0,
          durations: [],
        },
      ]),
    )
    const responses = { parse: {}, download: {}, other: {} }
    const download = { complete: 0, failed: 0, cancelled: 0, unfinished: 0, bytes: 0 }
    for (const request of requests.values()) {
      const response = request.request_response
      if (response?.operation && response.status !== undefined) {
        const counts = responses[response.operation]
        counts[response.status] = (counts[response.status] ?? 0) + 1
      }
      const transfer = request.download_transfer
      if (
        transfer ||
        (response?.operation === 'download' && response.status >= 200 && response.status < 300)
      ) {
        if (transfer?.outcome === 'success') download.complete++
        else if (transfer?.outcome === 'error') download.failed++
        else if (transfer?.outcome === 'cancelled') download.cancelled++
        else download.unfinished++
        download.bytes += transfer?.bytes ?? 0
      }
      if (!request.parse) continue
      parse.observed++
      const selection = request.parse_selection
      const terminal = request.parse_stream_complete ?? request.request_error ?? selection
      if (
        (response?.status >= 500 || terminal?.outcome === 'error') &&
        terminal?.outcome !== 'cancelled' &&
        !terminal?.cancelled &&
        terminal?.reason !== 'cancelled'
      )
        parse.serverErrors++
      if (
        terminal?.outcome === 'cancelled' ||
        terminal?.cancelled ||
        terminal?.reason === 'cancelled'
      )
        parse.cancelled++
      else if (terminal?.outcome === 'error' || request.request_error || response?.status >= 400)
        parse.failed++
      else if (terminal?.outcome === 'success' && selection?.outcome === 'success') {
        if (selection.reason === 'complete') parse.complete++
        else parse.unverified++
      } else parse.unfinished++
      if (finite(request.parse_first_usable?.sinceRequestMs))
        first.push(request.parse_first_usable.sinceRequestMs)
      if (finite(terminal?.sinceRequestMs)) final.push(terminal.sinceRequestMs)
      for (const attempt of request.attempts.values()) {
        const counts = upstream[attempt.strategy]
        counts.attempts++
        counts.successes += Number(attempt.success)
        counts.cancelled += Number(attempt.cancelled)
        counts.rateLimited += Number(attempt.rateLimited)
        counts.forbidden += Number(attempt.forbidden)
        counts.timeouts += Number(attempt.timeout)
        if (finite(attempt.durationMs)) counts.durations.push(attempt.durationMs)
      }
    }
    let attempts = 0
    for (const counts of Object.values(upstream)) {
      attempts += counts.attempts
      counts.durationMs = distribution(counts.durations)
      delete counts.durations
    }
    const completed = parse.complete + parse.unverified + parse.failed
    return {
      parse: {
        ...parse,
        successRate: completed ? (parse.complete + parse.unverified) / completed : null,
        firstUsableMs: distribution(first),
        finalMs: distribution(final),
      },
      upstream: {
        attempts,
        attemptsPerObservedParse: parse.observed ? attempts / parse.observed : null,
        strategies: upstream,
      },
      responseStatuses: responses,
      download,
      ignoredLines,
      duplicateEvents,
    }
  }
  return { add, finish }
}

export async function summarizeStream(stream, options) {
  const summary = createLogSummary(options)
  stream.setEncoding('utf8')
  let pending = '',
    bytes = 0
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 64 * 1024 * 1024) throw new Error('Log exceeds 64 MiB; split the input log')
    pending += chunk
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end)
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Log line exceeds 64 KiB')
      if (line.trim()) summary.add(line)
      pending = pending.slice(end + 1)
    }
    if (Buffer.byteLength(pending) > 64 * 1024) throw new Error('Log line exceeds 64 KiB')
  }
  if (pending.trim()) summary.add(pending)
  return summary.finish()
}
