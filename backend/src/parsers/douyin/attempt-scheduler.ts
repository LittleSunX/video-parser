interface WaitingAttempt {
  priority: number
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  cleanup: () => void
}

interface AttemptOptions {
  speculative?: boolean
  signal?: AbortSignal
}

export interface ScheduledAttempt {
  permit: Promise<() => void>
  readonly queued: boolean
  /** A queued lookahead becomes normal work when its predecessor fails. */
  promote(): void
}

export interface AttemptScheduler {
  /** Hold the permit through headers, body consumption and extraction, then release it. */
  acquire(attempt: number): Promise<() => void>
  schedule(attempt: number, options?: AttemptOptions): ScheduledAttempt
  /** Pause new grants while a known result is handed to the strategy selector. */
  hold(): () => void
  scope(): AttemptScope
}

export interface AttemptScope extends AttemptScheduler {
  releaseHolds(): void
}

/** First attempts, normal retries, then idle-slot lookahead; never more than two permits. */
export function createAttemptScheduler(
  signal: AbortSignal,
  onRetry: () => void,
  canSpeculate: () => boolean = () => true,
): AttemptScheduler {
  const queue: WaitingAttempt[] = []
  const holds = new Set<() => void>()
  let active = 0
  const onAbort = () => {
    for (const waiting of queue.splice(0)) {
      waiting.cleanup()
      waiting.reject(signal.reason)
    }
    for (const release of holds) release()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  function drain() {
    if (signal.aborted) {
      onAbort()
      return
    }
    if (holds.size) return
    while (active < 2 && queue.length) {
      let index = -1
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].priority === 2 && !canSpeculate()) continue
        if (index < 0 || queue[i].priority < queue[index].priority) index = i
      }
      if (index < 0) return
      const waiting = queue.splice(index, 1)[0]
      waiting.cleanup()
      active++
      let released = false
      waiting.resolve(() => {
        if (released) return
        released = true
        active--
        // The releasing strategy can enqueue its retry and wake a new strategy first.
        queueMicrotask(drain)
      })
    }
  }

  function schedule(attempt: number, options: AttemptOptions = {}): ScheduledAttempt {
    signal.throwIfAborted()
    options.signal?.throwIfAborted()
    let waiting: WaitingAttempt
    const permit = new Promise<() => void>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(waiting)
        if (index < 0) return
        queue.splice(index, 1)
        waiting.cleanup()
        reject(options.signal?.reason)
        queueMicrotask(drain)
      }
      waiting = {
        priority: options.speculative ? 2 : attempt === 1 ? 0 : 1,
        resolve,
        reject,
        cleanup: () => options.signal?.removeEventListener('abort', abort),
      }
      queue.push(waiting)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (!options.speculative && attempt > 1) onRetry()
      // Let the releasing caller enqueue its continuation before granting idle work.
      if (options.speculative) queueMicrotask(drain)
      else drain()
    })
    return {
      permit,
      get queued() {
        return queue.includes(waiting)
      },
      promote() {
        if (!queue.includes(waiting) || waiting.priority !== 2) return
        waiting.priority = attempt === 1 ? 0 : 1
        if (attempt > 1) onRetry()
        drain()
      },
    }
  }

  function hold() {
    signal.throwIfAborted()
    const release = () => {
      if (!holds.delete(release)) return
      if (!signal.aborted) queueMicrotask(drain)
    }
    holds.add(release)
    return release
  }

  function scope(): AttemptScope {
    const owned = new Set<() => void>()
    return {
      ...scheduler,
      hold() {
        const release = hold()
        const scopedRelease = () => {
          if (!owned.delete(scopedRelease)) return
          release()
        }
        owned.add(scopedRelease)
        return scopedRelease
      },
      releaseHolds() {
        for (const release of owned) release()
      },
    }
  }

  const scheduler: AttemptScheduler = {
    acquire: (attempt) => schedule(attempt).permit,
    schedule,
    hold,
    scope,
  }
  return scheduler
}
