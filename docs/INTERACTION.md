# Interaction

Interaction is expressed as React props and values, not an imperative view wrapper. The props below belong to
`<Chart>`; `<ChartStream>` and `<ChartWorkerStream>` accept the same ones (see "Streams").

## `<Chart>` or `<SvgChart>`

Everything below is `<Chart>`. `<SvgChart>` (`@aster/react/lite`) takes the same props except `renderer`; the ones that
need hit testing or the signal event loop need the `interaction` capability, passed as a prop
(`<SvgChart spec={spec} interaction={interaction} />`, `interaction` from `@aster/react/interaction`). API.md has the
full contract; in short:

| | `<Chart>` | `<SvgChart>` | `<SvgChart interaction={interaction}>` |
|---|---|---|---|
| pan / zoom (`panZoom`, `pan`, `zoom`, `view`, `onViewChange`, keyboard) | yes | yes | yes |
| interval brush (`onSelect`, `brush`) | yes | yes | yes |
| bound inputs (`signal.bind`), `setSignal`, `signalListeners` | yes | yes (as signal overrides) | yes |
| accessible tree, roving focus, legend toggling | yes | yes | yes |
| tooltips (`tooltip`, `renderTooltip`) | yes | compile error; reported at runtime | yes |
| point selection (`onPointSelect`, `selection`, `select`, `onSelectionChange`) | yes | compile error; reported at runtime | yes |
| `signal.on` event streams, `preventDefault` | yes | reported: the chart renders but does not respond | yes |
| `renderer="canvas"` | yes | compile error; renders SVG and reports | compile error; renders SVG and reports |

Pan/zoom, brushing and the keyboard contract do not use the hit index, so the light chart keeps them. Choose `<SvgChart>`
when bundle size matters and the chart is static, zoomable or brushable; add `interaction` when it needs tooltips,
clicks on marks or `signal.on`; use `<Chart>` when you want all of it with no setup or need the canvas renderer.
Every interaction check in `packages/react/scripts/browser-interaction.mts` runs against `<Chart>` and
`<SvgChart interaction>` in real Chromium.

## Which scales `x` and `y` mean

`ViewDomain`, `SelectionInterval` (the `onSelect`/`brush` interval) and the interval of a `SelectValue` have two keys,
`x` and `y`. They mean **the horizontal and the vertical positional scale**, not scales literally named `x` and `y`.
The scales are derived from the spec by position (`positionalScales(spec)` in `@aster/react`'s source, not exported):

1. Candidates for the horizontal orientation, in order: the scales of axes with `orient` `bottom` or `top`, then the
   scales referenced by the mark channels `x`, `x2`, `xc` in any encode set. For the vertical orientation: axes with
   `orient` `left` or `right`, then the channels `y`, `y2`, `yc`. Axes and marks are collected from the root and from
   nested groups.
2. The **first** candidate whose definition is a continuous type wins: `linear`, `log`, `pow`, `sqrt`, `symlog`, `time`
   or `utc`. Band, point and ordinal scales have no pannable domain and are skipped.
3. An orientation with no such candidate falls back to a continuous scale literally named `x` (respectively `y`);
   otherwise that orientation is unset and pan, zoom and brushing do nothing on it.

Only scales declared at the **root** of the spec are interactive (they are the scales the evaluated scene exposes). With
several continuous scales in one orientation (dual axes) only the first is driven, because a `ViewDomain` carries one
domain per orientation. So a Vega tutorial spec with `xscale`/`yscale` pans and zooms like one with `x`/`y`.

## Selection

```tsx
import * as React from 'react'
import { Chart, type SelectValue, type SelectionInterval } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 300,
  height: 200,
  data: [{ name: 'table' }],
  scales: [
    { name: 'xscale', type: 'linear', domain: { data: 'table', field: 'a' }, range: 'width' },
    { name: 'yscale', type: 'linear', domain: { data: 'table', field: 'b' }, range: 'height' },
  ],
  axes: [{ scale: 'xscale', orient: 'bottom' }, { scale: 'yscale', orient: 'left' }],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { enter: { x: { scale: 'xscale', field: 'a' }, y: { scale: 'yscale', field: 'b' } } } }],
}
const rows = [{ a: 1, b: 3 }, { a: 2, b: 5 }, { a: 4, b: 1 }]

export function Selectable(): React.ReactElement {
  const [selection, setSelection] = React.useState<SelectValue | null>(null)
  const [last, setLast] = React.useState<SelectionInterval | null>(null)
  return (
    <Chart
      spec={spec}
      data={{ table: rows }}
      selection={selection}                 // controlled; omit it to keep the value internally
      onSelectionChange={setSelection}      // { type: 'interval', interval: { x?, y? } } | { type: 'point', datum } | null
      onSelect={setLast}                    // legacy interval callback: the dragged interval, null for a click
      onPointSelect={(datum) => { console.log(datum) }}   // click: the datum under the pointer, null on empty space
    />
  )
}
```

`SelectValue` is `{ type: 'interval'; interval: SelectionInterval } | { type: 'point'; datum: Record<string, unknown> | null }`;
`SelectionInterval` is `{ x?: [number, number]; y?: [number, number] }` in data coordinates of the positional scales
above (an orientation whose scale is not invertible is omitted).

- `selection` (alias `select`; `select` wins when both are given) is controlled when supplied; omit it and the chart
  keeps the value itself. `onSelectionChange` receives every change, including `null`. `brush` (a `SelectionInterval`)
  is the older controlled form of the persisted rectangle.
- A drag of at least 3 px brushes an interval (selection gestures are on when `selection`, `onSelectionChange`,
  `onSelect`, `onPointSelect` or `brush` is present); the rectangle is drawn
  and `onSelect(interval)` / `onSelectionChange({ type: 'interval', ... })` fire on release. A movement of less than
  3 px is a click: `onPointSelect(datum)` gets the datum under the pointer (or `null`), `onSelect(null)` fires, and
  `onSelectionChange({ type: 'point', datum })` fires when `onPointSelect` or `onSelectionChange` is present.
- A click resolves through the scene hit index (`queryMark`), so SVG and canvas behave identically and guide labels are
  never selected.
- `Escape` clears the selection (`onSelectionChange(null)`, `onSelect(null)`, `onPointSelect(null)`), from the chart
  container or from any focused accessibility node that does not handle the key itself.
- Keyboard selection: `Enter` or `Space` on a focused mark node selects that mark's datum the same way (see
  "Accessibility").

## Spec-driven selections (Vega-Lite `params`)

A Vega-Lite spec declares its own selections (`params: [{name: "brush", select: "interval"}]`, `bind`, `{param}`
conditions...). They are not the `selection` / `onSelectionChange` props above: those are `<Chart>`'s own gesture
state (the rectangle it draws, the datum it picked) and know nothing about the spec. A spec-driven selection lives
where Vega-Lite puts it, in the compiled Vega spec, and the chart exposes it the way Vega does:

- the selection's **signals**, which the event loop writes as the user interacts: `<name>` is the resolved selection
  (`vlSelectionResolve` of its store: `{ field: [values] }`, the interval's `[lo, hi]` per field, plus `vlPoint` for a
  point selection), `<name>_tuple` the last tuple, `<name>_<field>` / `<name>_x` the bound-input and brush signals.
  Read them with `signalListeners={{ brush: (name, value) => ... }}` or `onSignal`, write them with `signals` or
  `ChartHandle.setSignal` (a write runs the dependent updates as an event would);
- the selection's **store**, the dataset `<name>_store` (`view.data("brush_store")` in Vega): the event loop's
  `modify(...)` edits it, and the chart keeps the edited rows and hands them back to the evaluation as an input, so
  the scene after an interaction is the one a fresh chart with those rows computes. The ref has no `view.data()`
  equivalent: read the selection through its signals (`<name>` resolves the store), or, outside React, through
  `bindSceneSignals`' `onData` hook ([API.md](API.md)).

`selection`, `onSelectionChange`, `onSelect` and `onPointSelect` do not report a spec-driven selection and a spec-driven
selection does not read them. Do not enable both on one chart: the `selection*` / `onSelect` / `brush` gestures and a
spec's interval brush listen to the same drag.

What works, and how it differs from Vega, precisely:

- The interaction needs the signal event loop: `<Chart>`, or `<SvgChart interaction={interaction}>`. `nearest` also
  needs `import '@aster/core/transforms'` (its voronoi cells). `renderer="canvas"` and `interactive={false}` bind no event loop (see [Signals](#signals)), so no spec selection
  reacts there. On `<ChartStream>` / `<ChartWorkerStream>` the edited store is not an input of the stream's
  evaluation (only signals and the view are), so a spec selection does not update the scene there.
- The state is the one Vega computes for the same input; `pnpm conformance:selections` drives the same native
  mouse, wheel and form-control input through vega-lite + Vega and through `@aster/vl` + `<Chart>` and compares every
  signal, every store and the SVG after each step (point click, shift-toggle, hover, `nearest`, brush, move, wheel
  zoom, legend click, `select` / `radio` / `range` / `checkbox` bindings, `bind: "scales"`, layered filters and lookups, and
  across concat, facet and repeat views: a brush filtering another view, a point selection linking two, a selection
  declared on the composition, a brush or a point per facet cell, bound scales shared by cells, a legend binding).
- A scale event (`{scale: "x"}`, which an unbound interval selection listens to so that its brush follows its
  scale) fires when the chart is bound to a scene whose scale differs from the previous one's.
- **Deviation:** a signal write is a fresh render ([Signals](#signals)): after it Aster draws what a new chart with those
  signal and store values draws, where Vega keeps the autosize, padding and axis-tick order it first computed. The
  conformance gate holds this exactly and with no tolerance: a step passes when Aster equals Vega's retained render, or
  when it equals the render of a NEW Vega view initialised with the same signals and stores (and Vega's own retained
  render differs); those steps are counted against a ceiling (`--max-retained`, like `sweep-signals`). Set
  `autosize: "none"` for a pan/zoom chart whose plot must not move.
- **Deviation:** `modify(name, ..., tuple)` / `remove` compare a tuple read back from `data()` by value (the evaluation
  does not hand out its input rows), where Vega compares tuple identity.
- **Selections in concat, facet and repeat views** (linked brushing, a brush per facet cell, a selection declared on the
  composition and given to every unit below it) work as in Vega: a unit's signals belong to its group mark, a Vega group
  scope with one copy per view or cell. The event loop scopes them the way Vega does (see [Group scopes](#group-scopes)).
  What it refuses is what vega-lite compiles to a Vega spec Vega rejects (a selection on a layer spec itself, or on a
  composition with a layer below it): see packages/vl/README.md.

### Group scopes

A group mark's `signals` (`SceneGroup.scopeSignals` on each group item of the scene) are a scope: each item has its own
copy, a facet cell's by its partition. The loop keeps the values events write under `<scope id>:<name>` in the signal
store (`onSignal` reports that key; the scope id is the group mark's name and place in the spec, plus the partition's
key), and hands them back to the next evaluation, which starts the scope's signals from them. What follows is Vega's own
and is checked against it (`pnpm conformance:signals`, the group-scope cases):

- a scope's signals shadow the enclosing scope's; `push: "outer"` makes a handler write the enclosing scope's signal;
- a selector string defaults to the `scope` source (`inScope(event.item)`: events whose item is in the scope's group);
  a group with no mark, axis, legend or title has no scope group, so `inScope` is false for every item;
- a scope's streams are the ones of the nearest enclosing scope that already listens to the same `source:type` (the
  view's, so a view-level handler and a scope's run in one dataflow run, the view's first), else its own; sibling
  scopes each have their own, and each stream is one DOM listener delivering as one dataflow run, in the order the
  streams were made. What an event changed is told to the host once, after all of them have run;
- `group()`, `group("cell")`, `x(group())`... resolve to the scope's group items; a picked group item that has a fill or
  a stroke (a facet cell, a nested view) is an event item where no mark inside is hit (never a data mark: tooltips and
  `onClick` do not see it); a facet cell's datum is a tuple that carries the partition's `count`, like Vega's facet
  aggregate;
- `scale()` in a scope's handlers sees the scales its group (and the groups around it) declare.

**Deviation:** Vega swallows the first firing of a `{signal}` handler that a scope declares on a signal of an enclosing
scope that never pulsed before (an internal flag of its operator); Aster fires it. No Vega-Lite output relies on it.

## Pan and zoom

`panZoom` enables both families; `pan` and `zoom` enable one each (`pan` + `zoom` is the same as `panZoom`).

| Gesture | Needs | Behaviour |
|---|---|---|
| wheel / trackpad | `zoom` | zoom around the cursor by an amount that follows `deltaY`; x and y are zoomed, or only x when `|deltaX| > |deltaY|` |
| two pointers | `zoom` | pinch zoom around the midpoint, both axes |
| drag | `pan` | pans, unless a selection prop or callback is present: then a plain drag brushes, and shift-drag (or the middle button) pans |
| `←` `→` `↑` `↓` | `pan` | pan by 8% of the visible span (25% with Shift) |
| `+` `=` / `-` `_` | `zoom` | zoom in or out by a factor of 1.5 around the middle of the visible domain |
| `0` / `Home` | `pan` or `zoom` | reset the view |
| double-click | `pan` or `zoom` | reset the view |

The keys act when the chart container has focus (it is a Tab stop, `tabIndex=0`, only while pan or zoom is enabled) and
when a continuous axis node is focused (see "Accessibility"). A zoom-only chart does not pan with the keyboard or the
pointer, and a pan-only chart does not zoom with the wheel or `+`/`-`. Pointer gestures are handled on the container, so
marks, tooltips, `signal.on` events and bound inputs underneath keep receiving their own events; a gesture on a form
control or link is ignored.

```tsx
import * as React from 'react'
import { Chart, type ViewDomain } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 300,
  height: 200,
  data: [{ name: 'table', values: [{ a: 1, b: 3 }, { a: 2, b: 5 }, { a: 40, b: 1 }] }],
  scales: [
    { name: 'xscale', type: 'linear', domain: { data: 'table', field: 'a' }, range: 'width' },
    { name: 'yscale', type: 'linear', domain: { data: 'table', field: 'b' }, range: 'height' },
  ],
  axes: [{ scale: 'xscale', orient: 'bottom' }, { scale: 'yscale', orient: 'left' }],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { enter: { x: { scale: 'xscale', field: 'a' }, y: { scale: 'yscale', field: 'b' } } } }],
}

export function Zoomable(): React.ReactElement {
  const [view, setView] = React.useState<ViewDomain | null>({ x: [0, 10] })   // x only: y stays automatic
  return <Chart spec={spec} panZoom maxZoom={200} view={view} onViewChange={setView} />
}
```

`view` is a controlled `{ x?: [number, number], y?: [number, number] }` (or `null` for the full extent); omit it for an
uncontrolled view. `onViewChange` receives the normalized view: a view equal to the base domain on an axis drops that
axis, and `null` means fully reset. The engine passes the view to the scales as `domainRaw`, so axes, grids, legends
and marks recompute in one pass, on SVG and canvas. Wheel and pinch zooming is clamped: zooming out never goes beyond the base domain (the
data extent when not zoomed), and `maxZoom` (default 1000) bounds zooming in (the visible span cannot drop below the
base span divided by `maxZoom`). The `+`/`-` keys step by a fixed factor and are not clamped. `ChartHandle.getView()`, `setView(view)` and `resetView()` do the same imperatively.

While zoomed, the base domain is the one of an unzoomed evaluation of the same inputs (cached, so a pan frame costs no
extra evaluation).

## Signals

Spec `signal.on` streams are bound to the rendered SVG with vega's event-stream semantics (selectors, filters,
throttle, `consume`, mark-scoped streams such as `@name:click` and `symbol:click`; the full list is in `docs/API.md`).
Updating a signal calls `onSignal(name, value)` and `signalListeners[name](name, value)`, and the value is stored in an
external store consumed with `useSyncExternalStore`, so each event is one normal React state transition (no tearing
under concurrent rendering).

```tsx
import * as React from 'react'
import { Chart, type ChartHandle } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 200,
  height: 60,
  signals: [{ name: 'w', value: 20 }],
  marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, height: { value: 10 }, width: { signal: 'w' }, fill: { value: 'steelblue' } } } }],
}

export function Signals(): React.ReactElement {
  const ref = React.useRef<ChartHandle>(null)
  return (
    <>
      <Chart ref={ref} spec={spec} signals={{ w: 30 }} signalListeners={{ w: (name, value) => { console.log(name, value) } }} />
      <button onClick={() => ref.current?.setSignal('w', 90)}>widen</button>
    </>
  )
}
```

- `signals` sets signal values from props; event- and input-driven values take precedence and are overwritten whenever
  the prop changes. `ChartHandle.getSignals()` returns the current store.
- A signal with a `bind` (`range`, `select`, `checkbox`, `radio`, `color`, `number` or text) renders a form control
  (a `data-aster-binds` element) after the chart and writes through the same path.
- `ChartHandle.setSignal(name, value)` is portable. With the SVG event loop bound it runs the spec's dependent signal
  updates, as an event would. On canvas, or with `interactive={false}`, there is no event loop, so the value is applied
  as a signal override and the listeners are notified.
- The spec's DOM event streams are bound on the SVG renderer only (`renderer="svg"`, `interactive` not `false`); the
  canvas renderer does not bind them. Use props, `setSignal`, `tooltip` and the selection props there.
- `denseMarks: 'auto'` stays off for a spec with `signal.on` streams, because those read the datum from per-item DOM
  nodes. Like vega's view, the chart calls `preventDefault()` on the events of its own surface that a stream listens to, except those
  `config.events.defaults` leaves alone (default `{allow: ['wheel']}`; `prevent` / `allow` lists or booleans as in vega, a `consume`d
  stream always prevents), so dragging a brush selects no text and a wheel still scrolls the page. The `preventDefault` prop is
  vega's `view.preventDefault()`: the verdict when the config names neither `prevent` nor `allow`;
  `logger` receives bind-time and run-time errors of the handlers.

### Timers and animation

`timer` event streams (`{"type": "timer", "throttle": 16.7}`, `"timer{100}"`) run on a port of d3-timer, the scheduler
vega-view uses, so ticks fall on the same instants with the same `{timestamp, elapsed}` (`pnpm conformance:signals` drives
real vega and Aster on one fake browser clock and compares frames). The timers belong to the chart's host element, not
to one rendered SVG: a re-bind after each render keeps the schedule, and they stop when the chart unmounts, when the host
element is removed from the document, or on `binding.release()` (vega's `view.finalize()`); nothing is left scheduled.
`bindSceneSignals` takes `owner` (the element the timers belong to; `<Chart>` passes its host) and `setTimerClock` from
`@aster/core` swaps the scheduler's clock for a controlled one (tests, hosts that step frames themselves). A Vega-Lite
animation (the `time` channel and its timer selection, see `packages/vl/README.md`) is a timer stream whose clock
signal feeds `modify` on the selection's store; the store and the other `modify` semantics are described above.

**Deviation from Vega: a signal write is a fresh render.** Aster is a pure function of (spec, data, signals): the scene
after a write equals the scene a fresh chart renders with those signal values. Vega's own second render can differ from
its own fresh render of the same signals, because it retains dataflow state: autosize runs once and again only when
width/height/padding/autosize change, so a chart whose content outgrows the view keeps its first size. The signals sweep
(`pnpm sweep-signals`, 166 cases) counts those cases as `retained` when Aster equals Vega's fresh render and Vega's
incremental render differs: 104 ok, 59 retained, 1 both-refused, 2 node-error, 0 differ, with a ceiling on `retained`
that can only be lowered (`scripts/gates.mjs`).

## Tooltips

`tooltip` renders the datum's primitive fields (`key: value`, numbers rounded to 3 decimals, fields starting with `__`
hidden) at the cursor. `renderTooltip(datum)` replaces the content inside the chart's React tree and enables tooltips by
itself. Both SVG (the `data-datum` attributes) and canvas and batched dense marks (the hit index) resolve the hovered
mark. Tooltips are off by default.

## Accessibility

The rendered SVG itself carries Vega's accessibility structure: axes, legends and titles are `role-axis` / `role-legend` / `role-title` containers with `role="graphics-symbol"`, `aria-roledescription` and a caption `aria-label`, data marks have their container and item labels (`aria: false` hides them), and the conformance gate compares this structure with real Vega's. The focusable overlay below is separate and shares the same captions.

The tree is scene-derived (`buildA11yTree`): one positioned focusable element per mark item (or one summary node per
mark that has more than `a11y.summaryThreshold` items, default 150), axis, legend, legend entry and title, with upstream-style captions,
`aria/description` channels, selected state, and continuous axes exposed as sliders. It is on by default; `a11y={false}`
removes it. `ariaLabel` labels the container.

It is a **roving tabindex** group: exactly one node has `tabindex=0` (the last focused node, else the first), all the
others `-1`. `Tab` enters the group at that node and the next `Tab` leaves it. Inside:

| Node | Keys |
|---|---|
| any node | `PageDown` / `PageUp` move to the next / previous node (wrapping). They exist because the arrows are taken by axis sliders |
| mark | `←` `↑` previous node, `→` `↓` next node, `Home` first, `End` last, `Enter` / `Space` select the datum (`onPointSelect`, `onSelect(null)`, `onSelectionChange({ type: 'point', datum })`; `aria-pressed` reflects the selection) |
| legend entry | `Enter` / `Space` hide or restore that series (`aria-pressed`); `←` `↑` previous, `→` `↓` next |
| legend, title | `←` `↑` previous node, `→` `↓` next node |
| continuous axis (slider) | with `pan` / `zoom` enabled: the arrows along that axis (`←` `→` on a horizontal axis, `↑` `↓` on a vertical one) pan only that axis, `+` `=` `-` `_` zoom only that axis, `0` / `Home` reset the view, Shift makes the pan steps larger. The other arrows are not handled by the slider and reach the chart container, which pans the other axis. Without pan or zoom the axis only answers to `PageUp` / `PageDown` |
| any node | `Escape` clears the selection (it is not handled by the nodes, so it reaches the container) |

Legend entries are keyboard toggles: shape/paint legends filter the matching SVG/canvas items without mutating the
session's cached scene.

## Streams

`<ChartStream>` and `<ChartWorkerStream>` render a stream's scene through the same `<Chart>` (DOM patcher, canvas
renderer, interaction, tooltips, accessibility tree), and these props work on them:

- `panZoom`, `pan`, `zoom`, `view`, `onViewChange`, `maxZoom` and the keyboard contract. The view is sent to the stream
  as `domainRaw` (a `null` entry clears it), so scales, marks and guides are recomputed inside the stream; resetting
  sends the clear. Appending rows does not discard the view, and does not discard rows the stream already holds.
- `signals`, `signalListeners`, `limits`, `textMetrics`, `urlPolicy`, selection, tooltip and `a11y` props. The ref of a
  stream component is the stream handle (`push`, `flush`, ...), not a `ChartHandle`, so there is no `setSignal` or
  `setView` there: drive them through `signals` and `view`.

```tsx
import * as React from 'react'
import { ChartStream, type ChartStreamHandle, type ViewDomain } from '@aster/react'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 300,
  height: 200,
  data: [{ name: 't', values: [{ a: 1, b: 1 }, { a: 10, b: 5 }] }],
  scales: [
    { name: 'xscale', type: 'linear', domain: { data: 't', field: 'a' }, range: 'width' },
    { name: 'yscale', type: 'linear', domain: { data: 't', field: 'b' }, range: 'height' },
  ],
  axes: [{ scale: 'xscale', orient: 'bottom' }, { scale: 'yscale', orient: 'left' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'xscale', field: 'a' }, y: { scale: 'yscale', field: 'b' } } } }],
}

export function LiveZoom(): React.ReactElement {
  const ref = React.useRef<ChartStreamHandle>(null)
  const [view, setView] = React.useState<ViewDomain | null>(null)
  return (
    <>
      <button onClick={() => ref.current?.push({ append: { t: [{ a: 20, b: 8 }] } })}>add a row</button>
      <ChartStream ref={ref} spec={spec} panZoom view={view} onViewChange={setView} />
    </>
  )
}
```

Limits of the stream route: the unzoomed (base) domain of a stream-fed chart is taken from the stream's scene while the
view is reset; while the chart is zoomed it keeps the last unzoomed base extent, so rows appended during a zoom extend
the reset extent only after the view is reset. The positional-scale rule above (root-scope scales, first per
orientation) is the same. `<ChartStream>` has no `data` or `dataChanges` prop: use `push({ data })` or
`push({ append })`.
