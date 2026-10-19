import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from 'vue'
import { mountApplication } from '../frontend/src/application'

vi.mock('vue', () => ({ createApp: vi.fn() }))
vi.mock('../frontend/src/App.vue', () => ({ default: {} }))

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8')
const feedbackScript = html.match(/<script data-startup-feedback>([\s\S]*?)<\/script>/)?.[1]

function browser() {
  const attributes = new Map([
    ['role', 'status'],
    ['aria-busy', 'true'],
  ])
  const panel = {
    setAttribute: (name, value) => attributes.set(name, value),
    remove: vi.fn(),
  }
  const message = { textContent: '正在加载网站，请稍候…' }
  const app = { replaceChildren: vi.fn() }
  const listeners = new Map()
  const window = {
    setTimeout,
    clearTimeout,
    addEventListener(type, callback, capture = false) {
      const key = type + ':' + capture
      const callbacks = listeners.get(key) ?? new Set()
      callbacks.add(callback)
      listeners.set(key, callbacks)
    },
    removeEventListener(type, callback, capture = false) {
      listeners.get(type + ':' + capture)?.delete(callback)
    },
    emit(type, event = {}) {
      for (const capture of [true, false])
        for (const callback of [...(listeners.get(type + ':' + capture) ?? [])]) callback(event)
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0),
    location: { reload: vi.fn() },
  }
  const document = {
    getElementById: (id) => ({ 'app-startup': panel, 'startup-message': message, app })[id] ?? null,
  }
  return { window, document, panel, message, attributes, app }
}

function startFeedback() {
  const page = browser()
  if (!feedbackScript) throw new Error('缺少启动反馈脚本')
  runInNewContext(feedbackScript, { window: page.window, document: page.document })
  return page
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(createApp).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('slow resources remain a pending startup and never cause an automatic refresh', () => {
  const page = startFeedback()
  const initial = page.message.textContent
  vi.advanceTimersByTime(7999)
  expect(page.message.textContent).toBe(initial)
  vi.advanceTimersByTime(1)
  expect(page.message.textContent).toContain('仍在加载')
  vi.advanceTimersByTime(120000)
  expect(page.attributes.get('role')).toBe('status')
  expect(page.attributes.get('aria-busy')).toBe('true')
  expect(page.panel.remove).not.toHaveBeenCalled()
  expect(page.window.location.reload).not.toHaveBeenCalled()
})

test.each([
  ['entry module', { tagName: 'SCRIPT', type: 'module' }],
  ['application stylesheet', { tagName: 'LINK', rel: 'stylesheet' }],
  ['uncaught entry error', undefined],
])('a real %s error ends waiting and keeps the static recovery panel', (_reason, target) => {
  const page = startFeedback()
  page.window.emit('error', { target: target ?? page.window })
  expect(page.attributes.get('role')).toBe('alert')
  expect(page.attributes.get('aria-live')).toBe('assertive')
  expect(page.attributes.get('aria-busy')).toBe('false')
  expect(page.message.textContent).toContain('失败')
  const failed = page.message.textContent
  vi.advanceTimersByTime(120000)
  expect(page.message.textContent).toBe(failed)
  expect(page.panel.remove).not.toHaveBeenCalled()
  expect(page.window.listenerCount()).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(page.window.location.reload).not.toHaveBeenCalled()
})

test('non-startup resource failures do not turn loading into an application failure', () => {
  const page = startFeedback()
  page.window.emit('error', { target: { tagName: 'IMG' } })
  page.window.emit('error', { target: { tagName: 'LINK', rel: 'icon' } })
  expect(page.attributes.get('role')).toBe('status')
  expect(page.window.listenerCount()).toBe(2)
})

test.each([0, 9000])('mounting after %i ms removes feedback and all startup observers', (delay) => {
  const page = startFeedback()
  vi.advanceTimersByTime(delay)
  page.window.emit('video-parser:startup', { detail: 'ready' })
  expect(page.panel.remove).toHaveBeenCalledOnce()
  expect(page.window.listenerCount()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  const lastMessage = page.message.textContent
  page.window.emit('error', { target: { tagName: 'SCRIPT', type: 'module' } })
  vi.advanceTimersByTime(120000)
  expect(page.message.textContent).toBe(lastMessage)
})

test('an application startup rejection displays failure even when no resource error event is fired', () => {
  const page = startFeedback()
  page.window.emit('video-parser:startup', { detail: 'failed' })
  expect(page.attributes.get('role')).toBe('alert')
  expect(page.attributes.get('aria-busy')).toBe('false')
  expect(page.window.listenerCount()).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})

test('an actual successful mount clears an earlier startup error without refreshing or retrying', () => {
  const page = startFeedback()
  page.window.emit('error', { target: page.window })
  expect(page.attributes.get('role')).toBe('alert')
  expect(page.panel.remove).not.toHaveBeenCalled()
  page.window.emit('video-parser:startup', { detail: 'ready' })
  expect(page.panel.remove).toHaveBeenCalledOnce()
  expect(page.window.listenerCount()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(page.window.location.reload).not.toHaveBeenCalled()
})

test('static HTML includes recovery and noscript instructions without executing the bootstrap', () => {
  const staticMarkup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  expect(staticMarkup).toMatch(/<a\b[^>]*href="\.\/"[^>]*>刷新页面<\/a>/)
  expect(staticMarkup).toMatch(/<noscript>[\s\S]*?JavaScript[\s\S]*?<\/noscript>/)
  expect(staticMarkup).toContain('id="startup-message"')
})

test('successful Vue mounting restores its normal runtime error handler', () => {
  const app = { config: {}, mount: vi.fn(), unmount: vi.fn() }
  vi.mocked(createApp).mockReturnValue(app)
  mountApplication()
  expect(app.mount).toHaveBeenCalledExactlyOnceWith('#app')
  expect(app.config.errorHandler).toBeUndefined()
  expect(app.unmount).not.toHaveBeenCalled()
})

test.each(['mount throws', 'component error is handled by Vue'])(
  '%s cannot be mistaken for a successful application startup',
  (failure) => {
    const page = browser()
    vi.stubGlobal('document', page.document)
    const previousHandler = vi.fn()
    const app = { config: { errorHandler: previousHandler }, mount: vi.fn(), unmount: vi.fn() }
    const error = new Error('startup component failed')
    app.mount.mockImplementation(() => {
      if (failure === 'mount throws') throw error
      app.config.errorHandler(error, null, 'setup')
    })
    vi.mocked(createApp).mockReturnValue(app)
    let caught
    try {
      mountApplication()
    } catch (failure) {
      caught = failure
    }
    expect(caught).toBe(error)
    expect(app.unmount).toHaveBeenCalledOnce()
    expect(page.app.replaceChildren).toHaveBeenCalledOnce()
    expect(app.config.errorHandler).toBe(previousHandler)
    expect(previousHandler).toHaveBeenCalledTimes(failure === 'mount throws' ? 0 : 1)
  },
)

test('the first component failure survives later component and unmount failures', () => {
  const page = browser()
  vi.stubGlobal('document', page.document)
  const first = new Error('original setup failure')
  const app = {
    config: {},
    mount: vi.fn(() => {
      app.config.errorHandler(first, null, 'setup')
      app.config.errorHandler(new Error('secondary render failure'), null, 'render')
    }),
    unmount: vi.fn(() => {
      throw new Error('cleanup failed')
    }),
  }
  vi.mocked(createApp).mockReturnValue(app)
  let caught
  try {
    mountApplication()
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(first)
  expect(page.app.replaceChildren).toHaveBeenCalledOnce()
  expect(app.config.errorHandler).toBeUndefined()
})

test('the entry logs the original startup error while keeping the generic failure feedback', async () => {
  const page = startFeedback()
  vi.stubGlobal('document', page.document)
  page.window.dispatchEvent = vi.fn((event) => page.window.emit(event.type, event))
  vi.stubGlobal('window', page.window)
  const original = new Error('component setup details')
  const app = {
    config: {},
    mount: vi.fn(() => app.config.errorHandler(original, null, 'setup')),
    unmount: vi.fn(),
  }
  vi.mocked(createApp).mockReturnValue(app)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await import('../frontend/src/main')
  await vi.dynamicImportSettled()
  expect(log).toHaveBeenCalledExactlyOnceWith('应用启动失败', original)
  expect(page.attributes.get('role')).toBe('alert')
  expect(page.message.textContent).toContain('失败')
  expect(page.message.textContent).not.toContain(original.message)
  expect(page.window.dispatchEvent).toHaveBeenCalledOnce()
})
