import { afterEach, expect, test, vi } from 'vitest'
import { pageMatchesExpectedVideo } from '../backend/src/parsers/douyin/page'
import { parseVideo } from '../backend/src/services/parse-service'

const expectedId = '123'
const otherId = '456'
const source = 'https://www.douyin.com/video/' + expectedId
const media = 'https://v.douyinvod.com/target.mp4'
const meta = '<meta property="og:video" content="' + media + '">'
const router = (data) => '<script>window._ROUTER_DATA=' + JSON.stringify(data) + '</script>'
const current = (id) => ({ aweme_id: id, video: {} })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([
  ['only media metadata under the target response URL', source, meta, true],
  ['media metadata without any identity', '', meta, false],
  ['legacy link-only metadata', '', '<a href="/video/123"></a>' + meta, true],
  [
    'a redirect to another work despite target metadata',
    'https://www.douyin.com/video/456',
    '<meta property="og:url" content="' + source + '">',
    false,
  ],
  [
    'different canonical even when the response URL stays unchanged',
    source,
    '<link rel="canonical" href="https://www.douyin.com/video/456">',
    false,
  ],
  [
    'different og:url with reversed attributes',
    source,
    '<meta content="/video/456" property="og:url">',
    false,
  ],
  [
    'relative canonical confirms a work under an ID-less response URL',
    'https://www.douyin.com/',
    '<link href="/video/123" rel="canonical">',
    true,
  ],
  [
    'unquoted attributes and case-insensitive names',
    '',
    '<META NAME=OG:URL CONTENT=https://www.douyin.com/video/123>',
    true,
  ],
  [
    'HTML entities in identity query parameters',
    '',
    '<meta property="og:url" content="https://www.douyin.com/?from=share&amp;modal_id=123">',
    true,
  ],
  [
    'HTTP canonical is identity evidence without fetching it',
    '',
    '<link rel="canonical" href="http://www.douyin.com/video/123">',
    true,
  ],
  [
    'conflicting canonical and og:url',
    source,
    '<link rel="canonical" href="/video/123"><meta property="og:url" content="/video/456">',
    false,
  ],
  [
    'a target link cannot overrule explicit different canonical',
    '',
    '<link rel="canonical" href="/video/456"><a href="/video/123">recommendation</a>',
    false,
  ],
  [
    'commented-out metadata is not a current identity',
    source,
    '<!-- <meta property="og:url" content="/video/456"> -->' + meta,
    true,
  ],
  [
    'metadata-looking script strings are not a current identity',
    source,
    '<script>const template=\'<link rel="canonical" href="/video/456">\'</script>' + meta,
    true,
  ],
  [
    'body metadata cannot override a real document head',
    source,
    '<html><head><link rel="canonical" href="/video/123"></head><body><meta property="og:url" content="/video/456"></body></html>',
    true,
  ],
  [
    'an unrelated host cannot provide missing Douyin identity',
    '',
    '<link rel="canonical" href="https://example.com/video/123">',
    false,
  ],
])('%s', (_label, responseUrl, html, expected) => {
  expect(pageMatchesExpectedVideo(responseUrl, html, expectedId)).toBe(expected)
})

test.each([
  ['root current item', current(otherId), false],
  ['aweme_detail current item', { aweme_detail: current(otherId) }, false],
  ['camel-case current item', { awemeDetail: current(otherId) }, false],
  ['current itemStruct', { itemInfo: { itemStruct: current(otherId) } }, false],
  [
    'root target plus unrelated recommendations',
    { ...current(expectedId), recommendations: [current(otherId)], aweme_list: [current(otherId)] },
    true,
  ],
  [
    'root other plus a recommended target',
    { ...current(otherId), recommendations: [current(expectedId)] },
    false,
  ],
  [
    'detail target plus an unrelated nested detail in recommendations',
    { aweme_detail: current(expectedId), recommendations: { aweme_detail: current(otherId) } },
    true,
  ],
  [
    'generic recommendation lists do not conflict',
    { aweme_list: [current(otherId)], item_list: [current(otherId)] },
    true,
  ],
  [
    'current video loader item followed by recommendations',
    {
      loaderData: {
        'video_(id)/page': { videoInfoRes: { item_list: [current(expectedId), current(otherId)] } },
      },
    },
    true,
  ],
  [
    'current video loader conflicts even if the target appears later',
    {
      loaderData: {
        'video_(id)/page': { videoInfoRes: { item_list: [current(otherId), current(expectedId)] } },
      },
    },
    false,
  ],
  [
    'current note loader',
    { loaderData: { 'note_(id)/page': { noteInfoRes: { item_list: [current(otherId)] } } } },
    false,
  ],
  [
    'current slides loader',
    { loaderData: { 'slides_(id)/page': { slidesInfoRes: { item_list: [current(otherId)] } } } },
    false,
  ],
  [
    'unrelated loader slots are ignored',
    {
      loaderData: {
        root: { recommendations: [current(otherId)] },
        'recommendations/page': { aweme_detail: current(otherId) },
      },
    },
    true,
  ],
])('%s', (_label, data, expected) => {
  expect(pageMatchesExpectedVideo(source, router(data) + meta, expectedId)).toBe(expected)
})

test('a known current router item confirms metadata even without a response URL', () => {
  expect(
    pageMatchesExpectedVideo('', router({ aweme_detail: current(expectedId) }) + meta, expectedId),
  ).toBe(true)
})

test('a target appearing only in recommendation JSON does not confirm an ID-less page', () => {
  const recommendations = { recommendations: [{ ...current(expectedId), share_url: source }] }
  expect(
    pageMatchesExpectedVideo('https://www.douyin.com/', router(recommendations) + meta, expectedId),
  ).toBe(false)
})

test.each([
  ['bare current item', current(otherId)],
  ['aweme_detail wrapper', { aweme_detail: current(otherId) }],
])(
  'full parse rejects another work hidden under the requested response URL: %s',
  async (_label, data) => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const wrongMedia = '<meta property="og:video" content="https://v.douyinvod.com/other-456.mp4">'
    const html = router(data) + wrongMedia + ' '.repeat(1100)
    const fetch = vi.fn(async (url) => {
      if (String(url).includes('/aweme/v1/web/') || String(url).includes('/aweme/v1/feed/'))
        return new Response('', { status: 503 })
      const response = new Response(html, { headers: { 'Content-Type': 'text/html' } })
      Object.defineProperty(response, 'url', { value: String(url) })
      return response
    })
    vi.stubGlobal('fetch', fetch)
    await expect(parseVideo(source)).rejects.toMatchObject({ code: 'VIDEO_RESOURCE_NOT_FOUND' })
    expect(fetch.mock.calls.some(([url]) => String(url) === source)).toBe(true)
  },
)

test('full parse preserves meta-only fallback when the final URL still identifies the target', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (url) => {
    if (String(url).includes('/aweme/v1/web/') || String(url).includes('/aweme/v1/feed/'))
      return new Response('', { status: 503 })
    const response = new Response(meta, { headers: { 'Content-Type': 'text/html' } })
    Object.defineProperty(response, 'url', { value: String(url) })
    return response
  })
  await expect(parseVideo(source)).resolves.toMatchObject({
    videoId: expectedId,
    videoUrl: media,
    parseStatus: 'complete',
  })
})
