/**
 * The web-platform types the engine's public signatures name: a DOM element, an event, a canvas, a URL, a blob, an abort signal, a
 * `fetch`. Each is the platform's own type where the consumer's TypeScript has it (`lib: ["dom"]`, or `@types/node` for `URL`,
 * `fetch`, `AbortSignal`, `Blob`) and a structural fallback where it does not, so a Node service that compiles with
 * `lib: ["es2022"]` and `skipLibCheck: false` can import `@aster-charts/core` without a DOM lib. (Naming `Element` or `URL` straight
 * in a declaration makes every consumer without them fail on the `.d.ts`, and with `skipLibCheck` quietly turns the parameter into
 * `any`.) With the types present the alias IS the platform's type: nothing is lost for a browser host.
 *
 * The test is `packages/conformance/src/declarations-consumer.test.ts`: every entry is compiled against `lib: ["es2022"]`.
 */

/** The instance type of the global constructor `K` where there is one, else `Fallback`. */
type Platform<K extends string, Fallback> = typeof globalThis extends { [P in K]: { prototype: infer T } } ? T : Fallback

/** A DOM `Element` (an svg, a canvas, a container). Without the DOM types: any object. */
export type HostElement = Platform<'Element', object>
/** A DOM `Event`. */
export type HostEvent = Platform<'Event', { readonly type: string }>
/** A DOM `EventTarget`. */
export type HostEventTarget = Platform<'EventTarget', object>
/** A DOM `Document`. */
export type HostDocument = Platform<'Document', object>
/** An `HTMLCanvasElement`. */
export type HostCanvas = Platform<'HTMLCanvasElement', { width: number; height: number; getContext(contextId: string, options?: unknown): unknown }>
/** A `Blob`. */
export type HostBlob = Platform<'Blob', { readonly size: number; readonly type: string; arrayBuffer(): Promise<ArrayBuffer> }>
/** An `AbortSignal`. */
export type HostAbortSignal = Platform<'AbortSignal', { readonly aborted: boolean }>
/** A WHATWG `URL`. */
export type HostUrl = Platform<
  'URL',
  {
    readonly href: string
    readonly origin: string
    readonly protocol: string
    readonly username: string
    readonly password: string
    readonly host: string
    readonly hostname: string
    readonly port: string
    readonly pathname: string
    readonly search: string
    readonly hash: string
  }
>
/** The global `fetch`. */
export type HostFetch = typeof globalThis extends { fetch: infer F } ? F : (input: string, init?: object) => Promise<unknown>
