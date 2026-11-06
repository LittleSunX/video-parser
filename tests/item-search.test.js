import { expect, test, vi } from 'vitest'
import {
  findFilterReason,
  findMediaItem,
  MAX_ITEM_SEARCH_STEPS,
} from '../backend/src/parsers/douyin/items'
import { DouyinParser } from '../backend/src/parsers/douyin'

const id = '1234567890123456789'
const media = (desc) => ({
  aweme_id: id,
  desc,
  video: { play_addr: { url_list: ['https://v.douyinvod.com/fixture.mp4'] } },
})

test('media lookup preserves breadth-first ordering and named-list priority', () => {
  const shallow = media('shallow')
  const deep = media('deep')
  expect(findMediaItem({ first: { deeper: deep }, second: shallow }, id)).toBe(shallow)
  const listItem = media('preferred list')
  const otherList = media('other list')
  expect(
    findMediaItem({ ...media('container'), aweme_list: [otherList], item_list: [listItem] }, id),
  ).toBe(listItem)
  expect(findMediaItem([{ deeper: deep }, shallow], id)).toBe(shallow)
})

test('cyclic and repeated references do not loop or change selection order', () => {
  const target = media('target')
  const shared = { nested: target }
  const input = { first: shared, second: shared }
  input.self = input
  expect(findMediaItem(input, id)).toBe(target)
  expect(findMediaItem(input, '9999999999999999999')).toBeUndefined()
  expect(findFilterReason(input)).toBeUndefined()
  shared.notice = 'reason'
  expect(findFilterReason(input)).toBe('reason')
})

test('a wide response finds a nested target without repeatedly shifting the queued objects', () => {
  const target = media('target after wide queue')
  const input = Array.from({ length: 100_000 }, (_, index) => ({ id: index }))
  input.push({ nested: target })
  expect(findMediaItem(input, id)).toBe(target)
})

test('filter lookup handles wide arrays without spreading them into function arguments', () => {
  const input = Array(150_000).fill(null)
  input.push({ notice: ' wide-array reason ' })
  expect(findFilterReason(input)).toBe('wide-array reason')
  expect(
    findFilterReason({ first: { deep: { notice: 'deep' } }, second: { notice: 'shallow' } }),
  ).toBe('shallow')
})

test.each([findMediaItem, findFilterReason])(
  '%s rejects excessive structure work with a controlled error',
  (search) => {
    const input = Array(MAX_ITEM_SEARCH_STEPS).fill(0)
    expect(() => search(input, id)).toThrowError(
      expect.objectContaining({ code: 'UPSTREAM_STRUCTURE_TOO_COMPLEX', status: 502 }),
    )
  },
)

test('a complexity failure in one upstream does not prevent another parse strategy succeeding', async () => {
  const originalFetch = globalThis.fetch
  const tooWide = JSON.stringify(Array(MAX_ITEM_SEARCH_STEPS).fill(0))
  const fetch = vi.fn(async (url) =>
    String(url).includes('/web/aweme/detail/')
      ? new Response(tooWide, { headers: { 'Content-Type': 'application/json' } })
      : Response.json({ aweme_list: [media('fallback strategy')] }),
  )
  globalThis.fetch = fetch
  try {
    const result = await new DouyinParser().parse('https://www.douyin.com/video/' + id)
    expect(result).toMatchObject({ videoId: id, title: 'fallback strategy', mediaType: 'video' })
    expect(fetch.mock.calls.some(([url]) => !String(url).includes('/web/aweme/detail/'))).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
