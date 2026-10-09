import type { AttemptScheduler, ScheduledAttempt } from './attempt-scheduler'
import type { ParsedMediaResult } from './types'
import type { VideoInfo } from '../../types/video'
import { mergeImageAssets } from './images'

/** Preserve metadata priority and enrich image identities without replacing known live tracks. */
export function mergeKnownResults(
  current: ParsedMediaResult | undefined,
  incoming: ParsedMediaResult,
  includeMetadata = true,
): ParsedMediaResult {
  if (!current) return incoming
  let video = includeMetadata ? mergeMetadata(current.video, incoming.video) : current.video
  const previous = current.video.images ?? []
  // Endpoint order also chooses media kind; a later image cannot replace a video winner.
  if (current.video.videoUrl && !previous.length)
    return { video, imagesComplete: current.imagesComplete }
  const additional = incoming.video.images ?? []
  if (!additional.length) return { video, imagesComplete: current.imagesComplete }
  const images =
    additional.length > previous.length
      ? mergeImageAssets(additional, previous)
      : mergeImageAssets(previous, additional)
  video = { ...video, mediaType: 'image', images }
  delete video.videoUrl
  let imagesComplete = current.imagesComplete
  if (!incoming.imagesComplete || images.length > previous.length) imagesComplete = false
  if (incoming.imagesComplete && additional.length >= images.length) imagesComplete = true
  // Explicit missing resources/new identities revoke confirmation, as in the selector.
  return {
    video,
    imagesComplete,
  }
}

export function mergeMetadata(current: VideoInfo, incoming: VideoInfo): VideoInfo {
  // Supplement the music URL/title as a pair, matching the strategy selector's existing rule.
  const musicTitle =
    !current.musicUrl && incoming.musicUrl
      ? incoming.musicTitle
      : current.musicTitle ||
        (!incoming.musicUrl || incoming.musicUrl === current.musicUrl
          ? incoming.musicTitle
          : undefined)
  return {
    ...current,
    author: current.author || incoming.author,
    cover: current.cover || incoming.cover,
    musicUrl: current.musicUrl || incoming.musicUrl,
    musicTitle,
  }
}

interface Candidate {
  ticket: ScheduledAttempt
  controller: AbortController
  done: boolean
  result?: ParsedMediaResult
}

/** A normal head plus its immediate successor; results retire in endpoint order. */
export function runOrderedCandidates(
  count: number,
  signal: AbortSignal,
  attempts: AttemptScheduler,
  run: (index: number, signal: AbortSignal) => Promise<ParsedMediaResult | undefined>,
  retain?: (result: ParsedMediaResult | undefined) => void,
): Promise<ParsedMediaResult | undefined> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const candidateSignal = AbortSignal.any([signal, controller.signal])
    const candidates: Array<Candidate | undefined> = []
    let head = 0
    let settled = false
    let decisionQueued = false
    let decisionTimer: ReturnType<typeof setTimeout> | undefined
    let resumeDrain: (() => void) | undefined

    function known(): ParsedMediaResult | undefined {
      let result: ParsedMediaResult | undefined
      for (const candidate of candidates) {
        if (candidate?.result) result = mergeKnownResults(result, candidate.result)
      }
      return result
    }

    function finish(result?: ParsedMediaResult, error?: unknown) {
      if (settled) return
      settled = true
      clearTimeout(decisionTimer)
      signal.removeEventListener('abort', onAbort)
      controller.abort()
      if (error !== undefined) reject(error)
      else resolve(result)
      // A strategy scope owns the handoff through accept(); standalone callers release here.
      if (error !== undefined || !('releaseHolds' in attempts)) resumeDrain?.()
    }

    function onAbort() {
      // Keep already delivered resources in the selector; cancellation never starts more work.
      finish(undefined, signal.reason)
    }

    function advance() {
      if (settled || signal.aborted || decisionQueued) return
      while (head < count && candidates[head]?.done) {
        if (candidates[head]?.result) {
          decisionQueued = true
          resumeDrain = attempts.hold()
          for (const candidate of candidates)
            if (candidate?.ticket.queued) candidate.controller.abort()
          // Drain already completed body/extraction microtasks; do not wait for a slow response.
          decisionTimer = setTimeout(() => finish(known()), 0)
          return
        }
        head++
      }
      if (head >= count) {
        finish()
        return
      }
      start(head, false)
      candidates[head]?.ticket.promote()
      if (head + 1 < count) start(head + 1, true)
    }

    function start(index: number, speculative: boolean) {
      if (settled || candidates[index]) return
      const cancellation = new AbortController()
      const attemptSignal = AbortSignal.any([candidateSignal, cancellation.signal])
      const candidate: Candidate = {
        ticket: attempts.schedule(index + 1, { speculative, signal: attemptSignal }),
        controller: cancellation,
        done: false,
      }
      candidates[index] = candidate
      void (async () => {
        let release: (() => void) | undefined
        try {
          release = await candidate.ticket.permit
          attemptSignal.throwIfAborted()
          const result = await run(index, attemptSignal)
          if (settled || attemptSignal.aborted) return
          candidate.result = result
          candidate.done = true
          if (result) retain?.(known())
          // Promote the next head before releasing this permit.
          advance()
        } catch {
          if (settled) return
          if (signal.aborted) onAbort()
          else {
            candidate.done = true
            advance()
          }
        } finally {
          release?.()
        }
      })()
    }

    signal.addEventListener('abort', onAbort, { once: true })
    if (count) advance()
    else finish()
  })
}
