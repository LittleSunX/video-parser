import { expect, test } from 'vitest'
import { startupPreloadPlugin } from '../frontend/vite.config.mjs'

function chunk(fileName, options = {}) {
  return {
    type: 'chunk',
    fileName,
    facadeModuleId: '/workspace/frontend/src/application.ts',
    imports: [],
    dynamicImports: [],
    viteMetadata: { importedCss: new Set() },
    ...options,
  }
}

function transform(bundle, entry, base = '/', path = '/index.html') {
  const plugin = startupPreloadPlugin()
  plugin.configResolved({ base })
  return plugin.transformIndexHtml.handler('', { bundle, chunk: entry, path })
}

test('HTML preloads the actual application output JS and CSS without applying blocking styles', () => {
  const application = chunk('assets/application-newHash.js', {
    viteMetadata: { importedCss: new Set(['assets/application-otherHash.css']) },
  })
  const entry = chunk('assets/bootstrap.js', { dynamicImports: [application.fileName] })
  const tags = transform({ [application.fileName]: application }, entry, '/preview/')
  expect(tags.map(({ attrs }) => attrs)).toEqual([
    {
      rel: 'modulepreload',
      crossorigin: 'anonymous',
      href: '/preview/assets/application-newHash.js',
    },
    {
      rel: 'preload',
      as: 'style',
      crossorigin: 'anonymous',
      href: '/preview/assets/application-otherHash.css',
    },
  ])
  expect(tags.some(({ attrs }) => attrs.rel === 'stylesheet')).toBe(false)
})

test('shared static dependencies preload once, while later dynamic features remain lazy', () => {
  const application = chunk('assets/application.js', {
    imports: ['assets/vendor.js'],
    dynamicImports: ['assets/later-feature.js'],
    viteMetadata: { importedCss: new Set(['assets/common.css']) },
  })
  const vendor = chunk('assets/vendor.js', {
    facadeModuleId: null,
    imports: [application.fileName],
    viteMetadata: { importedCss: new Set(['assets/common.css', 'assets/vendor.css']) },
  })
  const later = chunk('assets/later-feature.js', { facadeModuleId: '/workspace/src/later.ts' })
  const unrelated = chunk('assets/other-startup.js', { facadeModuleId: '/workspace/src/other.ts' })
  const bundle = Object.fromEntries(
    [application, vendor, later, unrelated].map((entry) => [entry.fileName, entry]),
  )
  const entry = chunk('assets/bootstrap.js', {
    dynamicImports: [unrelated.fileName, application.fileName],
  })
  const tags = transform(bundle, entry)
  const hrefs = tags.map(({ attrs }) => attrs.href)
  expect(hrefs).toEqual([
    '/assets/application.js',
    '/assets/vendor.js',
    '/assets/common.css',
    '/assets/vendor.css',
  ])
  expect(new Set(hrefs).size).toBe(hrefs.length)
})

test('relative builds resolve generated assets from the actual HTML location', () => {
  const application = chunk('assets/application.js', {
    facadeModuleId: 'D:\\workspace\\frontend\\src\\application.ts',
    viteMetadata: { importedCss: new Set(['assets/application.css']) },
  })
  const entry = chunk('assets/bootstrap.js', { dynamicImports: [application.fileName] })
  const tags = transform({ [application.fileName]: application }, entry, './', '/tools/index.html')
  expect(tags.map(({ attrs }) => attrs.href)).toEqual([
    '../assets/application.js',
    '../assets/application.css',
  ])
})

test('development HTML and entries without the application chunk add no guessed asset URLs', () => {
  expect(transform(undefined, undefined)).toEqual([])
  expect(transform({}, chunk('assets/bootstrap.js'))).toEqual([])
})
