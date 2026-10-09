interface WaitingAttempt {
  first: boolean
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
}

export interface AttemptScheduler {
  /** Hold the permit through headers, body consumption and extraction, then release it. */
  acquire(attempt: number): Promise<() => void>
}

/** Per-parse permits; a new strategy's first attempt takes precedence over queued retries. */
export function createAttemptScheduler(signal: AbortSignal, onRetry: () => void): AttemptScheduler {
  const queue: WaitingAttempt[] = []
  let active = 0
  const onAbort = () => {
    for (const waiting of queue.splice(0)) waiting.reject(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  function drain() {
    if (signal.aborted) {
      onAbort()
      return
    }
    while (active < 2 && queue.length) {
      const first = queue.findIndex((waiting) => waiting.first)
      const waiting = queue.splice(first < 0 ? 0 : first, 1)[0]
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

  return {
    acquire(attempt) {
      signal.throwIfAborted()
      return new Promise((resolve, reject) => {
        queue.push({ first: attempt === 1, resolve, reject })
        // Enqueue the next strategy before granting a retry, even if a permit is free.
        if (attempt > 1) onRetry()
        drain()
      })
    },
  }
}
