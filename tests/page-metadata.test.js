import { expect, test } from 'vitest'
import { extractMeta } from '../backend/src/parsers/douyin/page'

test.each([
  [
    'double-quoted title containing an apostrophe',
    '<meta property="og:title" content="Author\'s work">',
    'og:title',
    "Author's work",
  ],
  [
    'single-quoted title containing double quotes',
    "<meta property='og:title' content='A \"quoted\" work'>",
    'og:title',
    'A "quoted" work',
  ],
  [
    'author name containing an apostrophe',
    '<meta name="author" content="O\'Connor">',
    'author',
    "O'Connor",
  ],
  [
    'author name containing double quotes',
    "<meta name='author' content='A \"B\" C'>",
    'author',
    'A "B" C',
  ],
  [
    'video URL containing an apostrophe',
    '<meta property="og:video" content="https://v.douyinvod.com/a\'b.mp4?token=x\'y">',
    'og:video',
    "https://v.douyinvod.com/a'b.mp4?token=x'y",
  ],
  [
    'reversed attribute order',
    '<meta content="Author\'s work" property="og:title">',
    'og:title',
    "Author's work",
  ],
  [
    'reversed single-quoted attributes',
    "<meta content='A \"quoted\" work' property='og:title'>",
    'og:title',
    'A "quoted" work',
  ],
  [
    'case and whitespace around attributes',
    '<META\n PROPERTY = "OG:TITLE"\tCONTENT = "Author\'s work" >',
    'og:title',
    "Author's work",
  ],
  [
    'greater-than inside quoted content',
    '<meta property="og:title" content="A > B and C\'s work">',
    'og:title',
    "A > B and C's work",
  ],
  [
    'unquoted identity attribute',
    '<meta property=og:title content="Author\'s work">',
    'og:title',
    "Author's work",
  ],
  ['unquoted content', '<meta name=author content=creator>', 'author', 'creator'],
  [
    'HTML entities decoded exactly once',
    '<meta property="og:title" content="Tom &amp;amp; Jerry &#39; &quot; &lt; &gt;">',
    'og:title',
    'Tom &amp; Jerry \' " < >',
  ],
  [
    'URL query entities decoded once',
    '<meta property="og:video" content="https://v.douyinvod.com/a.mp4?a=1&amp;b=2&amp;amp;c=3">',
    'og:video',
    'https://v.douyinvod.com/a.mp4?a=1&b=2&amp;c=3',
  ],
])('extractMeta preserves %s', (_label, html, key, expected) => {
  expect(extractMeta(html, key)).toBe(expected)
})

test.each([
  ['HTML comment', '<!-- <meta property="og:title" content="fake"> -->'],
  [
    'script template',
    '<script>const template=\'<meta property="og:title" content="fake">\'</script>',
  ],
])('extractMeta ignores metadata-looking text in a %s', (_label, prefix) => {
  expect(extractMeta(prefix, 'og:title')).toBeUndefined()
  expect(extractMeta(prefix + '<meta property="og:title" content="real">', 'og:title')).toBe('real')
})

test.each([
  ['data-content', '<meta property="og:title" data-content="fake">'],
  ['data-property', '<meta data-property="og:title" content="fake">'],
  ['data-name', '<meta data-name="og:title" content="fake">'],
  [
    'property-looking attribute value',
    '<meta data-template=\'property="og:title"\' content="fake">',
  ],
  [
    'content-looking attribute value',
    '<meta property="og:title" data-template=\'content="fake"\'>',
  ],
  ['longer metadata key', '<meta property="og:title:extra" content="fake">'],
  [
    'multiple fake attributes inside a quoted value',
    '<meta data-note=\' property="og:title" content="fake" \'>',
  ],
])('extractMeta does not match %s as a real metadata attribute', (_label, html) => {
  expect(extractMeta(html, 'og:title')).toBeUndefined()
})

test('attribute-looking text cannot mask the real metadata attributes that follow it', () => {
  const html =
    '<meta data-note=\' property="og:title" content="fake" \' property="og:title" content="actual">'
  expect(extractMeta(html, 'og:title')).toBe('actual')
})
