/**
 * A deadline for work that may never answer. `conformance:geometry` drives a page whose last run hung for two hours without using
 * the CPU: a browser script that waits on something that never happens does not fail, it waits. Every call into the page goes through
 * this, so a page that stops answering fails the gate naming what it was doing.
 */
export class DeadlineError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${ms / 1000}s`)
    this.name = 'DeadlineError'
  }
}

/** `work`'s result, or a {@link DeadlineError} once `ms` have passed without it. */
export async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new DeadlineError(what, ms)) }, ms) })
  try { return await Promise.race([work, deadline]) } finally { clearTimeout(timer) }
}
