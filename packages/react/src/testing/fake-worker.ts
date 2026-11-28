/**
 * The one fake `Worker` of the React package's tests. It behaves as the platform's does where the hooks can tell:
 *
 *   - a request and its answer both cross `structuredClone`, so a function or a live scale map in a payload fails here as it
 *     does in a real worker (`DataCloneError`), and nothing is shared by reference;
 *   - the answer arrives on a LATER turn than the post (a microtask by default, a macrotask with `deliverOn = 'task'`), never
 *     inside `postMessage`;
 *   - it can be held (`hold`, then `release()` or `release('reverse')` to answer out of order), silent (`silent`: the request is
 *     recorded and never answered), made to fail (`fail('error' | 'messageerror')`) and is terminated by `terminate()`.
 *
 * `posted` is what the worker received (the clones), `streams` the chart streams it holds open, `terminated` whether the hook
 * ended it. The answers themselves come from the real handlers (`handleWorkerMessage`), the code a worker entry runs.
 */
import type { ChartStream } from '@aster-charts/core'
import { handleWorkerMessage, type ChartWorkerRequest, type ChartWorkerStreamRequest } from '../worker-impl.js'

export type PostedMessage = { id: number; kind?: string; op?: string; streamId?: number } & Record<string, unknown>

export class FakeWorker {
  listeners = new Map<string, Set<(event: unknown) => void>>()
  streams = new Map<number, ChartStream>()
  posted: PostedMessage[] = []
  terminated = false
  /** Hold every answer until `release()`: the request is received at once, the answer is not sent. */
  hold = false
  held: Array<() => void> = []
  /** Never answer: the request is recorded and dropped (a worker that hung). */
  silent = false
  /** When an answer arrives: after a microtask (the default) or on a later task. */
  deliverOn: 'microtask' | 'task' = 'microtask'

  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.get(type)?.delete(fn) }
  emit(type: string, event: unknown): void { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event) }
  /** The platform's failure events: `error` (the script threw) and `messageerror` (a message that could not be deserialised). */
  fail(type: 'error' | 'messageerror' = 'error', message = 'boom'): void { this.emit(type, { message }) }

  postMessage(request: ChartWorkerRequest | ChartWorkerStreamRequest): void {
    const wire = structuredClone(request) as typeof request & { kind?: string }
    this.posted.push(wire as unknown as PostedMessage)
    if (this.silent) return
    const respond = (): void => {
      const response = handleWorkerMessage(wire, this.streams)
      if (!response) return
      const answer = structuredClone(response)
      const send = (): void => this.emit('message', { data: answer })
      if (this.deliverOn === 'task') setTimeout(send, 0)
      else queueMicrotask(send)
    }
    if (this.hold) this.held.push(respond)
    else respond()
  }

  /** Answer what was held: in the order it was posted, or the other way round. */
  release(order: 'fifo' | 'reverse' = 'fifo'): void {
    const held = this.held.splice(0)
    for (const r of order === 'reverse' ? held.reverse() : held) r()
  }
  terminate(): void { this.terminated = true }
}
