# Performance

Aster keeps the differential engine from earlier phases and adds opt-in boundaries so
a chart pays only for the features it imports.

## What is fast

- **Session caching**: `createChartSession` fingerprints the spec skeleton, dataset
  identities, size, signals and `domainRaw`; identical inputs return the same scene.
- **Per-datum updates**: `<Chart dataChanges>` re-encodes only changed rows and reuses
  unchanged scene items; the DOM patcher skips clean subtrees.
- **Incremental scales**: continuous/discrete domains are reused when a changeset
  provably cannot move them.
- **DOM patching**: the first render emits the full SVG for SSR; later updates patch
  attributes in place instead of re-parsing the tree.
- **Canvas**: full repaint is scheduled on `requestAnimationFrame` with DPR backing.
- **Workers**: `useChartWorker` moves compile/evaluate/render off the main thread and
  falls back to synchronous execution when workers are unavailable.

## Bundle gates

`packages/benchmarks/scripts/budget.mjs` gates each published entry independently:
core, dom, canvas, hit, signals and React. This prevents an addon import from silently
inflating the base bundle. Measured gzip sizes are recorded next to the budgets.

## Practical guidance

- Large static dashboards: keep `<Chart incremental>` (default) and pass stable spec
  objects. Memoize spec builders at the call site.
- Streaming updates: supply `dataChanges` with the new immutable data array.
- Huge or untrusted specs: combine `limits` with `useChartWorker`.
- Dense marks: canvas avoids SVG node cost; hit testing uses a uniform grid above 400
  items.
- Accessibility tree: set `a11y={{ summaryThreshold: N }}` (default 150) to collapse
  very dense marks into one summary node.
