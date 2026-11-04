import { afterEach, expect, test, vi } from 'vitest'
import { extractDouyinVideoId, resolveSupportedUrl } from '../backend/src/utils/url'
import { parseVideo } from '../backend/src/services/parse-service'

const shortUrl = 'https://v.douyin.com/current-work/'
const targetId = '123'
const recommendedId = '456'
const targetUrl = 'https://www.douyin.com/video/' + targetId
const recommendedUrl = 'https://www.douyin.com/video/' + recommendedId
const router = (data) => '<script>window._ROUTER_DATA=' + JSON.stringify(data) + '</script>'
const item = (id) => ({
  aweme_id: id,
  desc: 'work-' + id,
  video: { play_addr: { url_list: ['https://v.douyinvod.com/work-' + id + '.mp4'] } },
})
const recommendations = router({ recommendations: [item(recommendedId)] })

function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html' } })
}

function mockShortPage(html) {
  const fetch = vi.fn(async () => htmlResponse(html))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function expectNoWorkIdentity(html) {
  mockShortPage(html)
  // An ambiguous landing page may stay unresolved or explicitly reject; it must not guess a work.
  await resolveSupportedUrl(new URL(shortUrl)).then(
    (url) => expect(extractDouyinVideoId(url)).toBeUndefined(),
    (error) => expect(error).toBeInstanceOf(Error),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([
  ['canonical', '<link rel="canonical" href="' + targetUrl + '">'],
  ['og:url', '<meta property="og:url" content="' + targetUrl + '">'],
  ['relative canonical', '<link href="/video/123" rel="canonical">'],
  ['query identity', '<meta content="/?from=share&amp;modal_id=123" property="og:url">'],
])('short landing page uses %s instead of an earlier recommendation', async (_label, metadata) => {
  const fetch = mockShortPage(recommendations + metadata)
  const resolved = await resolveSupportedUrl(new URL(shortUrl))
  expect(extractDouyinVideoId(resolved)).toBe(targetId)
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toBe(shortUrl)
})

test.each([
  ['root current item', { recommendations: [item(recommendedId)], ...item(targetId) }],
  ['aweme_detail', { recommendations: [item(recommendedId)], aweme_detail: item(targetId) }],
  [
    'video loader current item',
    {
      recommendations: [item(recommendedId)],
      loaderData: {
        'video_(id)/page': { videoInfoRes: { item_list: [item(targetId), item(recommendedId)] } },
      },
    },
  ],
  [
    'note loader current item',
    {
      recommendations: [item(recommendedId)],
      loaderData: { 'note_(id)/page': { noteInfoRes: { item_list: [item(targetId)] } } },
    },
  ],
])('short landing page accepts explicit %s without metadata', async (_label, data) => {
  mockShortPage(router(data))
  expect(extractDouyinVideoId(await resolveSupportedUrl(new URL(shortUrl)))).toBe(targetId)
})

test.each([
  ['recommendation router data', recommendations],
  ['generic item list', router({ item_list: [item(recommendedId)] })],
  ['generic aweme list', router({ aweme_list: [item(recommendedId)] })],
  ['a recommended anchor', '<a href="' + recommendedUrl + '">another work</a>'],
  ['a media URL query', '<img src="https://p.douyinpic.com/poster?modal_id=456">'],
  ['an unrelated canonical host', '<link rel="canonical" href="https://example.com/video/456">'],
  [
    'a lookalike canonical host',
    '<link rel="canonical" href="https://douyin.com.example.com/video/456">',
  ],
  ['commented router data', '<!-- ' + router({ aweme_detail: item(recommendedId) }) + ' -->'],
  [
    'router assignment in a JavaScript line comment',
    '<script>// window._ROUTER_DATA=' +
      JSON.stringify({ aweme_detail: item(recommendedId) }) +
      '\n</script>',
  ],
  [
    'router assignment in a JavaScript block comment',
    '<script>/* window._ROUTER_DATA=' +
      JSON.stringify({ aweme_detail: item(recommendedId) }) +
      ' */</script>',
  ],
  [
    'router assignment inside a JavaScript string',
    "<script>const sample='window._ROUTER_DATA=" +
      JSON.stringify({ aweme_detail: item(recommendedId) }) +
      "'</script>",
  ],
  ['commented metadata', '<!-- <link rel="canonical" href="' + recommendedUrl + '"> -->'],
  [
    'metadata inside a script string',
    '<script>const template=\'<meta property="og:url" content="' + recommendedUrl + '">\'</script>',
  ],
])('short landing page does not guess identity from %s', async (_label, html) => {
  await expectNoWorkIdentity(html)
})

test.each([
  [
    'canonical and og:url disagree',
    '<link rel="canonical" href="' +
      targetUrl +
      '"><meta property="og:url" content="' +
      recommendedUrl +
      '">',
  ],
  [
    'metadata and current router item disagree',
    '<link rel="canonical" href="' +
      targetUrl +
      '">' +
      router({ aweme_detail: item(recommendedId) }),
  ],
])('short landing page refuses conflicting evidence: %s', async (_label, html) => {
  await expectNoWorkIdentity(html)
})

test('fake metadata and router data in comments do not override real current identity', async () => {
  mockShortPage(
    '<!-- ' +
      router({ aweme_detail: item(recommendedId) }) +
      ' -->' +
      '<script>const template=\'<link rel="canonical" href="' +
      recommendedUrl +
      '">\'</script>' +
      '<link rel="canonical" href="' +
      targetUrl +
      '">',
  )
  expect(extractDouyinVideoId(await resolveSupportedUrl(new URL(shortUrl)))).toBe(targetId)
})

test('commented router assignment cannot mask the real assignment in the same script', async () => {
  mockShortPage(
    '<script>/* window._ROUTER_DATA=' +
      JSON.stringify({ aweme_detail: item(recommendedId) }) +
      ' */\n' +
      'window._ROUTER_DATA=' +
      JSON.stringify({ aweme_detail: item(targetId) }) +
      '</script>',
  )
  expect(extractDouyinVideoId(await resolveSupportedUrl(new URL(shortUrl)))).toBe(targetId)
})

test('a script template containing a fake head cannot mask real current metadata', async () => {
  mockShortPage(
    '<script>const template=\'<head><link rel="canonical" href="' +
      recommendedUrl +
      '"></head>\'</script>' +
      '<link rel="canonical" href="' +
      targetUrl +
      '">',
  )
  expect(extractDouyinVideoId(await resolveSupportedUrl(new URL(shortUrl)))).toBe(targetId)
})

test.each([
  'const pattern=/window._ROUTER_DATA={"aweme_id":"456"}/;',
  'const pattern=/prefix.*window._ROUTER_DATA={"aweme_id":"456"}/;',
  'const pattern=/prefix\\/.*window._ROUTER_DATA={"aweme_id":"456"}/;',
  'const pattern=/[/].*window._ROUTER_DATA={"aweme_id":"456"}/;',
  'if (ready) /prefix.*window._ROUTER_DATA={"aweme_id":"456"}/.test(value);',
  'function pattern(){ return /prefix.*window._ROUTER_DATA={"aweme_id":"456"}/; }',
])('router-looking regular expression is not an assignment: %s', async (script) => {
  await expectNoWorkIdentity('<script>' + script + '</script>')
  mockShortPage(
    '<script>' +
      script +
      ';window._ROUTER_DATA=' +
      JSON.stringify({ aweme_detail: item(targetId) }) +
      '</script>',
  )
  expect(extractDouyinVideoId(await resolveSupportedUrl(new URL(shortUrl)))).toBe(targetId)
})

test('division expressions do not hide a real router assignment in the same script', async () => {
  mockShortPage(
    '<script>const ratio=6/2;window._ROUTER_DATA=' +
      JSON.stringify({ aweme_detail: item(targetId) }) +
      ';const inverse=2/6;</script>',
  )
  expect(extractDouyinVideoId(await resolveSupportedUrl(new URL(shortUrl)))).toBe(targetId)
})

test('ordinary redirects still resolve the target and stop before fetching its page', async () => {
  const fetch = vi.fn(
    async () => new Response(null, { status: 302, headers: { Location: targetUrl } }),
  )
  vi.stubGlobal('fetch', fetch)
  expect((await resolveSupportedUrl(new URL(shortUrl))).toString()).toBe(targetUrl)
  expect(fetch).toHaveBeenCalledOnce()
})

test('short-link redirects cannot escape to an unrelated host', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { Location: 'https://example.com/video/123' } }),
  )
  vi.stubGlobal('fetch', fetch)
  await expect(resolveSupportedUrl(new URL(shortUrl))).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
  })
  expect(fetch).toHaveBeenCalledOnce()
})

test('full short-link parse returns the current work even if a recommendation appears first', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const fetch = vi.fn(async (input) => {
    const url = new URL(String(input))
    if (url.toString() === shortUrl)
      return htmlResponse(recommendations + '<link rel="canonical" href="' + targetUrl + '">')
    if (url.pathname.includes('/aweme/v1/web/aweme/detail/')) {
      // Return exactly the requested item so the regression cannot pass by masking a bad resolve.
      const requestedId = url.searchParams.get('aweme_id')
      return Response.json({ aweme_detail: item(requestedId) })
    }
    return new Response('', { status: 503 })
  })
  vi.stubGlobal('fetch', fetch)
  await expect(parseVideo('复制分享链接 ' + shortUrl)).resolves.toMatchObject({
    videoId: targetId,
    title: 'work-' + targetId,
    videoUrl: 'https://v.douyinvod.com/work-' + targetId + '.mp4',
  })
  const detailIds = fetch.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname.includes('/aweme/v1/web/aweme/detail/'))
    .map((url) => url.searchParams.get('aweme_id'))
  expect(detailIds).toContain(targetId)
  expect(detailIds).not.toContain(recommendedId)
})
