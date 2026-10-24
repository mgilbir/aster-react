# ADR 0002: Interaction is React state over scale domains

Date: 2026-10-20
Status: Accepted

## Context

Pan/zoom/selection can be implemented as an imperative view object (as vega-embed
does) or as React values. Imperative state is easy to wire to Vega's event streams but
bypasses React's rendering model: controlled inputs, transitions and concurrent
rendering all become second-class.

The engine already exposes `domainRaw` on the scale layer, and `RuntimeInput` already
carries signal values. Those are the only two mutation points interaction needs.

## Decision

1. **Selection is a value.** `SelectValue` is either an interval or a point datum.
   Props are controlled/uncontrolled in the React idiom (`selection` +
   `onSelectionChange`); the legacy callbacks are convenience adapters.
2. **View is a value.** `ViewDomain { x?, y? }` is fed to scales as `domainRaw`.
   Wheel/drag/pinch/keyboard compute the next domain in pure helpers
   (`interaction.ts`) and emit it through `onViewChange`. No imperative view is
   required, although `ChartHandle` exposes one for hosts that need it.
3. **Signals are an external store.** Spec `signal.on` updates write to a store read
   with `useSyncExternalStore`, so a signal event is one synchronous React state
   transition with a stable snapshot.
4. **Hit testing is scene-based.** Clicks resolve through the uniform-grid hit index,
   with guides excluded (`queryMark`), so SVG and canvas share semantics.

## Consequences

- Pan/zoom recomputes the full scene (marks and guides) through the normal pipeline;
  correctness and SSR are unchanged, at the cost of a full evaluate per gesture frame.
  Hosts can throttle with `requestAnimationFrame` if needed.
- A controlled view can be persisted, serialized, or shared between charts.
- Accessibility and selection state are derived from the same scene, so they cannot
  drift from the rendered marks.
- Canvas has no DOM signal streams; props/`setSignal` are the portable path.

## Amendments

*2026-10-23, to match the code.*

- The last consequence is superseded: `ChartHandle.setSignal` works on every renderer. With the SVG event loop bound
  it runs the spec's dependent signal updates; on canvas, or with `interactive={false}`, it applies the value as a
  signal override. Listeners are notified either way. Canvas still has no DOM event streams, so a spec's `signal.on`
  handlers only fire on SVG.
- Pan/zoom is derived by scale position (the first continuous scale per orientation, root scope), not by scale name;
  `pan` and `zoom` are separate switches. See [INTERACTION.md](../INTERACTION.md).
- `<ChartStream>` supports the same interaction as `<Chart>` (pan/zoom, signals, selection, tooltips, a11y).
