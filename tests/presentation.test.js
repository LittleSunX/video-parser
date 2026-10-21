import { expect, test } from 'vitest'
import { imageSaveSummary, presentTitle } from '../frontend/src/utils/presentation'

test('separates hashtags without dropping text after them or duplicating tags', () => {
  expect(presentTitle('三星为目，照见古今。 #王者荣耀cos #少司缘 后续正文 #少司缘')).toEqual({
    text: '三星为目，照见古今。 后续正文',
    tags: ['#王者荣耀cos', '#少司缘'],
  })
  expect(presentTitle('普通标题\n第二行')).toEqual({ text: '普通标题 第二行', tags: [] })
  expect(presentTitle('#三星堆')).toEqual({ text: '分享的作品', tags: ['#三星堆'] })
  expect(presentTitle('')).toEqual({ text: '未命名作品', tags: [] })
})

test('save summary counts actual targets, including live-only and missing resources', () => {
  const video = {
    images: [
      { url: 'still.jpg' },
      { url: 'live.jpg', livePhotoUrl: 'live.mp4' },
      { url: '', livePhotoUrl: 'motion-only.mp4' },
      { url: '' },
    ],
  }
  expect(imageSaveSummary(video, true)).toBe('1 张图片 + 2 段动态视频')
  expect(imageSaveSummary(video, false)).toBe('2 张高清原图')
  expect(imageSaveSummary({ images: [{ url: '', livePhotoUrl: 'live.mp4' }] }, false)).toBe('')
  expect(imageSaveSummary(null, true)).toBe('')
})
