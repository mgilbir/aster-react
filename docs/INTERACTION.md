# Interaction

Interaction is expressed as React props and values, not an imperative view wrapper.

## Selection

```ts
type SelectValue =
  | { type: 'interval'; interval: { x?: [number, number]; y?: [number, number] } }
  | { type: 'point'; datum: Record<string, unknown> | null }
```

`<Chart selection onSelectionChange>` is controlled; omit `selection` to keep the
value internally. The legacy `onSelect`/`brush` (interval) and `onPointSelect` (click)
callbacks remain. A click resolves through the scene hit index, so SVG and canvas
behave identically; guide labels are excluded from `queryMark`.

## Pan and zoom

`panZoom` enables:

| Gesture | Behaviour |
|---|---|
| wheel / trackpad | zoom both axes around the cursor (shift-drag pans when selection is active) |
| drag | pan when no selection handler is present; shift-drag otherwise |
| two pointers | pinch zoom around the midpoint |
| `←/→/↑/↓` | pan (chart container or axis slider focus) |
| `+`/`-` | zoom in/out |
| `0` / `Home` | reset |
| double-click | reset |

`view` is a controlled `{ x?: [number, number], y?: [number, number] }`; the engine
passes it to scales as `domainRaw`, so axes, grids, legends and marks recompute in one
pass. `maxZoom` bounds the zoom-in span.

## Signals

Spec `signal.on` streams are bound to the rendered SVG. Updating a signal calls
`onSignal(name, value)` / `signalListeners[name]`, and the value is stored in an
external store consumed with `useSyncExternalStore`, so each event is one normal React
state transition (no tearing under concurrent rendering). `ChartHandle.setSignal`
drives the same path imperatively. Canvas currently does not bind spec DOM streams;
use props/`setSignal` for canvas-driven signals.

## Tooltips

`tooltip` renders the datum's primitive fields at the cursor. `renderTooltip(datum)`
replaces the content inside the chart's React tree. Both SVG (DOM data attributes) and
canvas (hit index) resolve the hovered mark.

## Accessibility

See [API.md](API.md#accessibility-keyboard-contract). The tree is scene-derived: one
positioned focusable element per mark item (or a dense summary), axis, legend, legend
entry and title, with upstream-style captions, `aria/description` channels, selected
state, and continuous axes exposed as sliders.

Legend entries are keyboard toggles: focus an entry and press `Enter`/`Space` to hide
or restore that series (`aria-pressed` reflects the state). Shape/paint legends filter
the matching SVG/canvas items without mutating the session's cached scene.
