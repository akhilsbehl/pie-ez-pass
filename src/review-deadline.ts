// One reviewer-owned total deadline, including discovery/auth, provider work,
// parsing and retry waits. A signal race bounds even uncooperative providers.
export function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

export function createReviewDeadline(timeoutMs: number, sessionSignal?: AbortSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = sessionSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, sessionSignal])
  return { signal, timedOut: () => controller.signal.aborted, dispose: () => clearTimeout(timer) }
}

export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach handlers even when already aborted, so late provider rejection cannot
  // become an unhandled rejection after the permission boundary has returned.
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

export function reviewSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return }
    const onAbort = (): void => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const REVIEW_MAX_ATTEMPTS = 3
export const REVIEW_RETRY_DELAYS_MS = [250, 1_000]
