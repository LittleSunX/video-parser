import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useElementVisibility } from '../frontend/src/composables/useElementVisibility'

const scopes = []
let observers
beforeEach(() => {
  observers = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback, options) {
        this.callback = callback
        this.options = options
        this.observe = vi.fn()
        this.disconnect = vi.fn()
        observers.push(this)
      }
    },
  )
})
afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.unstubAllGlobals()
})
function setup(element = {}) {
  const target = shallowRef(element)
  const scope = effectScope()
  scopes.push(scope)
  const visible = scope.run(() => useElementVisibility(target))
  return { target, scope, visible }
}
function intersect(observer, target, ratio, isIntersecting = ratio > 0) {
  observer.callback([{ target, intersectionRatio: ratio, isIntersecting }])
}

test('only a fully visible inline action replaces the fixed action', () => {
  const { target, visible } = setup()
  const observer = observers[0]
  expect(visible.value).toBe(false)
  expect(observer.observe).toHaveBeenCalledWith(target.value)
  expect(observer.options.threshold).toContain(1)
  intersect(observer, target.value, 0.5)
  expect(visible.value).toBe(false)
  intersect(observer, target.value, 1)
  expect(visible.value).toBe(true)
  intersect(observer, target.value, 0)
  expect(visible.value).toBe(false)
})

test.each([
  [1, 0, false],
  [0, 1, true],
])('uses the last matching entry in a batch from ratio %s to %s', (first, last, expected) => {
  const { target, visible } = setup()
  const observer = observers[0]
  intersect(observer, target.value, first)
  observer.callback([
    { target: target.value, intersectionRatio: first, isIntersecting: first > 0 },
    { target: {}, intersectionRatio: last, isIntersecting: last > 0 },
    { target: target.value, intersectionRatio: last, isIntersecting: last > 0 },
    { target: {}, intersectionRatio: first, isIntersecting: first > 0 },
  ])
  expect(visible.value).toBe(expected)
})

test.each([0, 1])('unrelated entries preserve visibility at ratio %s', (ratio) => {
  const { target, visible } = setup()
  const observer = observers[0]
  intersect(observer, target.value, ratio)
  intersect(observer, {}, 1 - ratio)
  expect(visible.value).toBe(ratio === 1)
})

test('replacing or removing the inline action disconnects the old observer', async () => {
  const { target, visible, scope } = setup()
  const oldTarget = target.value
  intersect(observers[0], oldTarget, 1)
  target.value = {}
  await nextTick()
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  expect(visible.value).toBe(false)
  intersect(observers[0], oldTarget, 1)
  expect(visible.value).toBe(false)
  intersect(observers[1], target.value, 1)
  expect(visible.value).toBe(true)
  target.value = undefined
  await nextTick()
  expect(observers[1].disconnect).toHaveBeenCalledOnce()
  expect(visible.value).toBe(false)
  target.value = {}
  await nextTick()
  scope.stop()
  expect(observers[2].disconnect).toHaveBeenCalledOnce()
})

test('a missing action or unsupported observer leaves the fixed action available', () => {
  expect(setup(null).visible.value).toBe(false)
  expect(observers).toHaveLength(0)
  vi.stubGlobal('IntersectionObserver', undefined)
  expect(setup().visible.value).toBe(false)
})
