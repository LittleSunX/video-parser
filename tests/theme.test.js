import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const styles = readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8')

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1]
  if (!block) throw new Error(`Missing CSS rule: ${selector}`)
  return Object.fromEntries(
    block
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(':')
        return [declaration.slice(0, colon), declaration.slice(colon + 1).trim()]
      }),
  )
}

test('the shared palette uses the approved neutral-light colors', () => {
  expect(declarations(':root')).toMatchObject({
    color: 'var(--ink)',
    background: 'var(--page)',
    '--page': '#f5f6f7',
    '--paper': '#ffffff',
    '--ink': '#25282d',
    '--muted': '#656b74',
    '--line': '#e4e7ea',
    '--accent': '#25282d',
    '--accent-hover': '#3a3f46',
    '--soft': '#eceef0',
  })
})

test('interactive and translucent surfaces do not retain the previous warm palette', () => {
  expect(declarations('.input-row:focus-within')).toMatchObject({
    'border-color': '#959da7',
    'box-shadow': '0 0 0 3px #25282d0c',
  })
  expect(declarations('.parse-button:hover:not(:disabled)').background).toBe('var(--accent-hover)')
  expect(styles).not.toMatch(
    /#(?:fffcf6|ded8cc|423223|322e28|191713|231f1b|fffaf4)(?:[0-9a-f]{2})?\b/i,
  )
  expect(declarations('.error-card').color).toBe('#983f2d')
  expect(declarations('.warning-card').color).toBe('#805d31')
  expect(declarations('.download-task.is-failed .task-heading').color).toBe('#983f2d')
})

test('only the platform support dot uses muted green, leaving its label and other status dots unchanged', () => {
  expect(declarations('.platform-support > span').background).toBe('#4f8a68')
  expect(declarations('.platform-support').color).toBe('var(--muted)')
  expect(declarations('.result-status > span').background).toBe('var(--accent)')
})

test('browser chrome and startup recovery use the same neutral palette', () => {
  const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8')
  const favicon = readFileSync(new URL('../frontend/public/favicon.svg', import.meta.url), 'utf8')
  const themeColor = html.match(/<meta name="theme-color" content="([^"]+)"/)?.[1]
  expect(themeColor).toBe(declarations(':root')['--page'])
  expect(html).toMatch(/id="app-startup"[^>]*style="[^"]*color: #25282d;/)
  expect(html).toContain('<a href="./" style="color: #25282d">刷新页面</a>')
  expect([...favicon.matchAll(/fill="(#[a-f0-9]+)"/g)].map((match) => match[1])).toEqual([
    '#25282d',
    '#ffffff',
    '#cbd0d6',
  ])
})
