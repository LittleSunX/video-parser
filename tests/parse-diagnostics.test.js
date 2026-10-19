import { afterEach, expect, test, vi } from 'vitest'
import { effectScope } from 'vue'
import {
  createParseDiagnostics,
  ParseError,
  serializeParseDiagnostics,
} from '../frontend/src/api/parse-error'
import { parseVideo } from '../frontend/src/api/video'
import { useVideoPage } from '../frontend/src/composables/useVideoPage'

const requestId = '12345678-1234-4234-8234-123456789abc'
const secondRequestId = '87654321-4321-4321-8321-cba987654321'
const workerVersion = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const frontendCommit = 'a'.repeat(40)
const privateInput = 'PRIVATE_SHARE_TEXT https://www.douyin.com/video/123?private=INPUT_SECRET'
const privateMedia = 'https://v.douyinvod.com/video.mp4?signature=MEDIA_SECRET'
const secretMarkers = [
  'PRIVATE_SHARE_TEXT',
  'INPUT_SECRET',
  'MEDIA_SECRET',
  'PRIVATE_MESSAGE',
  'PRIVATE_STACK',
  'PRIVATE_CAUSE',
  'PRIVATE_HEADER',
]
const video = {
  platform: 'douyin',
  mediaType: 'video',
  videoId: '123',
  title: 'PRIVATE_TITLE',
  sourceUrl: 'https://www.douyin.com/video/123',
  videoUrl: privateMedia,
}
const scopes = []

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function failed(promise) {
  return promise.then(
    () => {
      throw new Error('Expected this parse to reject')
    },
    (error) => error,
  )
}

function clock() {
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return (value) => {
    now = value
  }
}

function reportIsPrivate(report) {
  const text = serializeParseDiagnostics(report)
  for (const marker of secretMarkers) expect(text).not.toContain(marker)
  for (const field of ['input', 'url', 'sourceUrl', 'videoUrl', 'message', 'stack', 'cause'])
    expect(JSON.parse(text)).not.toHaveProperty(field)
  return JSON.parse(text)
}

function errorResponse(id = requestId) {
  return Response.json(
    { success: false, error: { code: 'PARSE_FAILED', message: '暂时无法获取作品' } },
    {
      status: 422,
      headers: { 'X-Request-ID': id, 'X-Worker-Version': workerVersion },
    },
  )
}

function stream() {
  let writer
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        writer = controller
      },
      cancel,
    }),
    {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Request-ID': requestId,
        'X-Worker-Version': workerVersion,
      },
    },
  )
  return {
    response,
    cancel,
    send(event) {
      writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'))
    },
    close() {
      writer.close()
    },
  }
}

function page(writeText = vi.fn(async () => {})) {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    isSecureContext: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const scope = effectScope()
  scopes.push(scope)
  const app = scope.run(useVideoPage)
  app.input.value = privateInput
  return { app, writeText, scope }
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

test('diagnostic construction and serialization strip source data and arbitrary error fields', () => {
  const unsafe = {
    schemaVersion: 99,
    code: 'PARSE_FAILED',
    stage: 'preview',
    durationMs: 123.6,
    responseMs: 10.4,
    firstPreviewMs: 70.7,
    streaming: true,
    status: 200,
    requestId,
    workerVersion,
    frontendCommit,
    input: privateInput,
    sourceUrl: privateInput,
    videoUrl: privateMedia,
    message: 'PRIVATE_MESSAGE',
    stack: 'PRIVATE_STACK',
    cause: { message: 'PRIVATE_CAUSE' },
    serverTiming: 'primary;desc="PRIVATE_HEADER"',
    toJSON: () => ({ input: privateInput }),
  }
  const expected = {
    schemaVersion: 1,
    code: 'PARSE_FAILED',
    stage: 'preview',
    durationMs: 124,
    responseMs: 10,
    firstPreviewMs: 71,
    streaming: true,
    status: 200,
    requestId,
    workerVersion,
    frontendCommit,
  }
  expect(createParseDiagnostics(unsafe)).toEqual(expected)
  expect(reportIsPrivate(unsafe)).toEqual(expected)
  expect(new ParseError('PARSE_FAILED', '公共提示', unsafe).diagnostics).toEqual(expected)
})

test.each([NaN, Infinity, -1, '123', null])(
  'invalid timing %s is omitted or normalized without leaking arbitrary metadata',
  (value) => {
    expect(
      createParseDiagnostics({
        code: 'PRIVATE_MESSAGE',
        stage: privateInput,
        durationMs: value,
        responseMs: value,
        firstPreviewMs: value,
        status: 600,
        streaming: 'true',
        requestId: '-'.repeat(36),
        workerVersion: 'PRIVATE_HEADER',
        frontendCommit: privateMedia,
      }),
    ).toEqual({
      schemaVersion: 1,
      code: 'UNKNOWN_ERROR',
      stage: 'request',
      durationMs: 0,
    })
  },
)

test('finite timing is bounded to one day and unknown Worker versions remain recognizable', () => {
  expect(
    createParseDiagnostics({
      code: 'CLIENT_TIMEOUT',
      stage: 'response',
      durationMs: 1e12,
      responseMs: 1e12,
      firstPreviewMs: 1e12,
      workerVersion: 'unknown',
    }),
  ).toEqual({
    schemaVersion: 1,
    code: 'CLIENT_TIMEOUT',
    stage: 'response',
    durationMs: 86400000,
    responseMs: 86400000,
    firstPreviewMs: 86400000,
    workerVersion: 'unknown',
  })
})

test('pre-response network failure gets safe whole-request timing without raw error retention', async () => {
  vi.stubEnv('VITE_APP_COMMIT', frontendCommit)
  const tick = clock()
  const cause = Object.assign(new Error('PRIVATE_CAUSE ' + privateMedia), {
    stack: 'PRIVATE_STACK',
  })
  const raw = Object.assign(new Error('PRIVATE_MESSAGE ' + privateInput, { cause }), {
    stack: 'PRIVATE_STACK',
  })
  const fetch = vi.fn(async () => {
    tick(460)
    throw raw
  })
  vi.stubGlobal('fetch', fetch)
  const error = await failed(parseVideo(privateInput))
  expect(error).toBeInstanceOf(ParseError)
  expect(error.message).toBe('网络连接失败，请检查网络后重试')
  expect(error.cause).toBeUndefined()
  expect(reportIsPrivate(error.diagnostics)).toEqual({
    schemaVersion: 1,
    code: 'NETWORK_ERROR',
    stage: 'request',
    durationMs: 360,
    frontendCommit,
  })
  expect(fetch).toHaveBeenCalledOnce()
})

test('public JSON failures preserve the message and request number but copy only safe response fields', async () => {
  vi.stubEnv('VITE_APP_COMMIT', frontendCommit)
  const tick = clock()
  const response = errorResponse()
  response.headers.set('Server-Timing', 'primary;desc="PRIVATE_HEADER"')
  vi.spyOn(response, 'json').mockImplementation(async () => {
    tick(400)
    return {
      success: false,
      error: {
        code: 'PARSE_FAILED',
        message: '公共错误提示',
        cause: { message: 'PRIVATE_CAUSE' },
        stack: 'PRIVATE_STACK',
      },
      input: privateInput,
      media: privateMedia,
    }
  })
  const fetch = vi.fn(async () => {
    tick(180)
    return response
  })
  vi.stubGlobal('fetch', fetch)
  const error = await failed(parseVideo(privateInput))
  expect(error.message).toBe('公共错误提示（请求编号：' + requestId + '）')
  expect(reportIsPrivate(error.diagnostics)).toEqual({
    schemaVersion: 1,
    code: 'PARSE_FAILED',
    stage: 'response',
    durationMs: 300,
    responseMs: 80,
    streaming: false,
    status: 422,
    requestId,
    workerVersion,
    frontendCommit,
  })
  expect(fetch).toHaveBeenCalledOnce()
})

test('unknown API codes and untrusted identifier headers cannot become diagnostic content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { success: false, error: { code: 'PRIVATE_MESSAGE', message: '公共提示' } },
        {
          status: 422,
          headers: {
            'X-Request-ID': '-'.repeat(36),
            'X-Worker-Version': 'PRIVATE_HEADER',
          },
        },
      ),
    ),
  )
  const error = await failed(parseVideo(privateInput))
  expect(error.message).toBe('公共提示')
  expect(error.diagnostics.code).toBe('UNKNOWN_ERROR')
  expect(error.diagnostics).not.toHaveProperty('requestId')
  expect(error.diagnostics).not.toHaveProperty('workerVersion')
  reportIsPrivate(error.diagnostics)
})

test('legacy 415 fallback includes both fetches in timing and associates only the final response', async () => {
  const tick = clock()
  const old = new Response('old format', {
    status: 415,
    headers: { 'X-Request-ID': requestId },
  })
  vi.spyOn(old.body, 'cancel').mockImplementation(() => new Promise(() => {}))
  const fetch = vi
    .fn()
    .mockImplementationOnce(async () => {
      tick(160)
      return old
    })
    .mockImplementationOnce(async (_url, options) => {
      tick(350)
      expect(options.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(options.body)).toEqual({ url: privateInput })
      return errorResponse(secondRequestId)
    })
  vi.stubGlobal('fetch', fetch)
  const error = await failed(parseVideo(privateInput))
  expect(error.diagnostics).toMatchObject({
    stage: 'response',
    durationMs: 250,
    responseMs: 250,
    status: 422,
    requestId: secondRequestId,
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(old.body.cancel).toHaveBeenCalledOnce()
})

test('network failure during 415 fallback does not reuse the obsolete 415 request metadata', async () => {
  const tick = clock()
  const fetch = vi
    .fn()
    .mockImplementationOnce(async () => {
      tick(140)
      return new Response(null, {
        status: 415,
        headers: { 'X-Request-ID': requestId, 'X-Worker-Version': workerVersion },
      })
    })
    .mockImplementationOnce(async () => {
      tick(520)
      throw new Error('PRIVATE_MESSAGE ' + privateInput)
    })
  vi.stubGlobal('fetch', fetch)
  const error = await failed(parseVideo(privateInput))
  expect(error.diagnostics).toEqual({
    schemaVersion: 1,
    code: 'NETWORK_ERROR',
    stage: 'request',
    durationMs: 420,
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('a truncated preview stream records first preview once and never includes candidate metadata', async () => {
  const tick = clock()
  const source = stream()
  const preview = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      tick(120)
      return source.response
    }),
  )
  const rejection = failed(parseVideo(privateInput, undefined, preview))
  await vi.waitFor(() => expect(source.response.body.locked).toBe(true))
  tick(180)
  source.send({ type: 'preview', data: video })
  await vi.waitFor(() => expect(preview).toHaveBeenCalledOnce())
  tick(220)
  source.send({ type: 'preview', data: video })
  await vi.waitFor(() => expect(preview).toHaveBeenCalledTimes(2))
  tick(300)
  source.close()
  const error = await rejection
  expect(error.message).toContain('传输中断')
  expect(reportIsPrivate(error.diagnostics)).toMatchObject({
    code: 'INVALID_RESPONSE',
    stage: 'preview',
    durationMs: 200,
    responseMs: 20,
    firstPreviewMs: 80,
    streaming: true,
    status: 200,
    requestId,
    workerVersion,
  })
  expect(serializeParseDiagnostics(error.diagnostics)).not.toContain('PRIVATE_TITLE')
})

test.each(['manual', 'timeout'])(
  '%s abort during a pending stream keeps cancellation and timeout diagnostics distinct',
  async (kind) => {
    const tick = clock()
    const source = stream()
    const cancellation = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => source.response),
    )
    const rejection = failed(parseVideo(privateInput, cancellation.signal, vi.fn()))
    await vi.waitFor(() => expect(source.response.body.locked).toBe(true))
    tick(450)
    cancellation.abort(
      kind === 'timeout' ? new DOMException('PRIVATE_MESSAGE', 'TimeoutError') : undefined,
    )
    const error = await rejection
    if (kind === 'manual') {
      expect(error.name).toBe('AbortError')
      expect(error).not.toHaveProperty('diagnostics')
    } else {
      expect(error).toBeInstanceOf(ParseError)
      expect(reportIsPrivate(error.diagnostics)).toMatchObject({
        code: 'CLIENT_TIMEOUT',
        stage: 'response',
        durationMs: 350,
        streaming: true,
        status: 200,
      })
    }
    expect(source.cancel).toHaveBeenCalledOnce()
  },
)

test('pre-response timeout carries safe diagnostics without HTTP or request identifiers', async () => {
  const tick = clock()
  const cancellation = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    ),
  )
  const rejection = failed(parseVideo(privateInput, cancellation.signal))
  tick(500)
  cancellation.abort(new DOMException('PRIVATE_MESSAGE ' + privateInput, 'TimeoutError'))
  const error = await rejection
  expect(error.message).toBe('解析超时，请重试')
  expect(reportIsPrivate(error.diagnostics)).toEqual({
    schemaVersion: 1,
    code: 'CLIENT_TIMEOUT',
    stage: 'request',
    durationMs: 400,
  })
})

test('failure only prepares a safe report; copying requires an explicit action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => errorResponse()),
  )
  const { app, writeText } = page()
  await app.handleParse()
  expect(app.errorMessage.value).toContain('暂时无法获取作品')
  expect(app.errorDiagnostics.value.requestId).toBe(requestId)
  expect(writeText).not.toHaveBeenCalled()
  app.errorDiagnostics.value.input = privateInput
  app.errorDiagnostics.value.serverTiming = 'PRIVATE_HEADER'
  await app.copyProblemInfo()
  expect(writeText).toHaveBeenCalledOnce()
  expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(
    reportIsPrivate(app.errorDiagnostics.value),
  )
  expect(app.notice.value).toContain('问题信息已复制')
  expect(app.copyingProblemInfo.value).toBe(false)
})

test('explicit retry uses the current input once and clears the previous failure immediately', async () => {
  const next = deferred()
  const fetch = vi.fn().mockResolvedValueOnce(errorResponse()).mockReturnValueOnce(next.promise)
  vi.stubGlobal('fetch', fetch)
  const { app, writeText } = page()
  await app.handleParse()
  expect(app.errorDiagnostics.value).toBeDefined()
  const currentInput = privateInput + ' CURRENT_INPUT'
  app.input.value = currentInput
  const retry = app.handleParse()
  expect(app.loading.value).toBe(true)
  expect(app.errorMessage.value).toBe('')
  expect(app.errorDiagnostics.value).toBeUndefined()
  expect(fetch.mock.calls[1][1].body.get('url')).toBe(currentInput)
  await app.handleParse()
  await app.copyProblemInfo()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(writeText).not.toHaveBeenCalled()
  next.resolve(Response.json({ success: true, data: video }))
  await retry
  expect(app.video.value).toEqual(video)
  expect(app.errorDiagnostics.value).toBeUndefined()
})

test.each(['clear', 'cancel', 'dispose'])(
  '%s discards the previous report and disables copying',
  async (action) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse()),
    )
    const { app, writeText, scope } = page()
    await app.handleParse()
    expect(app.errorDiagnostics.value).toBeDefined()
    if (action === 'clear') app.handleClear()
    else if (action === 'cancel') app.cancelParse()
    else scope.stop()
    expect(app.errorDiagnostics.value).toBeUndefined()
    await app.copyProblemInfo()
    expect(writeText).not.toHaveBeenCalled()
  },
)

test('clipboard denial gives explicit feedback while keeping the safe failure report available', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => errorResponse()),
  )
  const writeText = vi.fn(async () => {
    throw new DOMException('PRIVATE_MESSAGE ' + privateInput, 'NotAllowedError')
  })
  const { app } = page(writeText)
  await app.handleParse()
  const report = app.errorDiagnostics.value
  await app.copyProblemInfo()
  expect(app.notice.value).toContain('复制失败')
  expect(app.notice.value).not.toContain('PRIVATE_MESSAGE')
  expect(app.copyingProblemInfo.value).toBe(false)
  expect(app.errorDiagnostics.value).toBe(report)
})

test.each(['clear', 'cancel', 'dispose'])(
  'a late clipboard completion after %s cannot restore an old success notice',
  async (action) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse()),
    )
    const clipboard = deferred()
    const { app, scope, writeText } = page(vi.fn(() => clipboard.promise))
    await app.handleParse()
    const copy = app.copyProblemInfo()
    await app.copyProblemInfo()
    expect(writeText).toHaveBeenCalledOnce()
    expect(app.copyingProblemInfo.value).toBe(true)
    if (action === 'clear') app.handleClear()
    else if (action === 'cancel') app.cancelParse()
    else scope.stop()
    const currentNotice = app.notice.value
    clipboard.resolve()
    await copy
    expect(app.notice.value).toBe(currentNotice)
    expect(app.copyingProblemInfo.value).toBe(false)
    expect(app.errorDiagnostics.value).toBeUndefined()
  },
)

test('an obsolete copy cannot clear a newer copy in progress or replace its notice', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(errorResponse())
    .mockResolvedValueOnce(errorResponse(secondRequestId))
  vi.stubGlobal('fetch', fetch)
  const firstClipboard = deferred()
  const secondClipboard = deferred()
  const writeText = vi
    .fn()
    .mockReturnValueOnce(firstClipboard.promise)
    .mockReturnValueOnce(secondClipboard.promise)
  const { app } = page(writeText)
  await app.handleParse()
  const oldCopy = app.copyProblemInfo()
  await app.handleParse()
  expect(app.errorDiagnostics.value.requestId).toBe(secondRequestId)
  const newCopy = app.copyProblemInfo()
  firstClipboard.resolve()
  await oldCopy
  expect(app.copyingProblemInfo.value).toBe(true)
  expect(app.notice.value).not.toContain('已复制')
  secondClipboard.resolve()
  await newCopy
  expect(app.copyingProblemInfo.value).toBe(false)
  expect(app.notice.value).toContain('问题信息已复制')
})

test('a cancelled old request resolving late cannot replace a newer failure report', async () => {
  const oldResponse = deferred()
  const fetch = vi
    .fn()
    .mockReturnValueOnce(oldResponse.promise)
    .mockResolvedValueOnce(errorResponse(secondRequestId))
  vi.stubGlobal('fetch', fetch)
  const { app } = page()
  const oldParse = app.handleParse()
  app.cancelParse()
  app.input.value = privateInput + ' NEW_INPUT'
  await app.handleParse()
  const currentReport = app.errorDiagnostics.value
  expect(currentReport.requestId).toBe(secondRequestId)
  oldResponse.resolve(errorResponse(requestId))
  await oldParse
  expect(app.errorDiagnostics.value).toBe(currentReport)
  expect(app.errorMessage.value).toContain(secondRequestId)
  expect(app.errorMessage.value).not.toContain(requestId)
  expect(app.loading.value).toBe(false)
})
