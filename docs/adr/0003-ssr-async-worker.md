# ADR 0003: SSR first, async by Suspense, workers as an opt-in

Date: 2026-10-20
Status: Accepted

## Context

The engine is synchronous: compile/evaluate/render are pure functions over a spec and
inputs. That makes SSR and deterministic snapshots cheap, but URL data is inherently
async and large specs can block a frame. React 19 provides `use()`/Suspense; bundlers
provide Workers but not uniformly (SSR, older hosts, jsdom).

## Decision

1. **SSR emits the complete SVG string.** `<Chart>` serializes the full SVG on its
   first render, on both server and client, so text and geometry exist before
   hydration. Subsequent updates patch the DOM in place.
2. **Strict hydration uses the DOM patcher.** React hydration through
   `dangerouslySetInnerHTML` cannot guarantee the server `<svg>` node is preserved on
   every React version. Hosts that need that guarantee call
   `renderChartToStaticMarkup` + `hydrateChart`, which patches the existing node
   directly.
3. **Async data uses Suspense/`use()`.** `useSpecData` returns a stable promise keyed
   by the spec object and fetch implementation; the loader addon is dynamically
   imported so it stays out of the base bundle. A promise `spec` on `<Chart>` suspends
   to the host's boundary (no internal boundary, so the host fallback is used).
4. **Workers are optional and symmetric.** `handleChartWorkerRequest` is a pure
   request handler; `useChartWorker` uses a supplied/factory Worker when available and
   runs the same handler synchronously otherwise. Responses strip runtime/function
   handles so the scene is structured-cloneable.

## Consequences

- SSR HTML is larger (full geometry), but hydration has no layout flash and no
  measurement pass.
- Data loading is explicit and cacheable; there is no hidden fetch in the renderer.
- Worker mode returns a scene without event-loop handles, so interaction that depends
  on signals stays on the main thread unless the host forwards events.
- The loader addon and worker entry remain separately gateable in the bundle budget.
