# Animation

Two things move in an Aster chart:

- **A Vega-Lite `time` animation** (the `time` channel and its timer selection): the spec steps through its frames by
  itself; see [`packages/vl/README.md`](../packages/vl/README.md) and [INTERACTION.md](INTERACTION.md#timers-and-animation).
- **Transitions** (`transition` prop): a chart whose data changes animates from the picture on screen to the new scene
  instead of jumping to it. With `transition` set, the frames of a `time` animation are tweened too.

Transitions are opt-in. Without the prop nothing changes: no frame is scheduled and the chart draws exactly what it drew
before, which is what the conformance gates compare against Vega.

```tsx
<Chart spec={spec} data={{ table: rows }} transition />
<Chart spec={spec} data={{ table: rows }} transition={{ duration: 500, easing: 'cubic-out', reducedMotion: 'user' }} />
```

| option | default | |
|---|---|---|
| `duration` | `300` | milliseconds |
| `easing` | `'cubic-in-out'` | `'linear'`, `'quad-in'`, `'quad-out'`, `'quad-in-out'`, `'cubic-in'`, `'cubic-out'`, `'cubic-in-out'`, `'sin-in'`, `'sin-out'`, `'sin-in-out'`, or a function from linear progress in [0, 1] to eased progress |
| `reducedMotion` | `'user'` | `'user'`: no animation when the user prefers reduced motion (`prefers-reduced-motion: reduce`); `'always'`: never animate; `'never'`: animate whatever the preference |
| `maxItems` | `1000` | the most items a transition animates: a change that would move more (data mark items and axis parts whose position, size, opacity or colour changes; an item that is the same in both scenes does not count) is drawn at once. See [Loading and cost](#loading-and-cost) |

`<SvgChart>` takes the same prop, and `<ChartStream>` / `<ChartWorkerStream>` pass it to the chart they render.

## What animates

A transition starts when the chart gets a new scene because its **data** changed:

- `data` with another rows array for a dataset (with or without `dataChanges`); a `data` object made anew on every render
  that holds the same arrays is not a change;
- new inline rows in an otherwise equal spec (the same chart, see `chartSkeleton`);
- a scene streamed into `<ChartStream>` or `<ChartWorkerStream>`;
- the next frame of a Vega-Lite `time` animation (its timer moved the selection store on).

Everything else is drawn at once: a signal (a bound input, `setSignal`, a hover or brush handler), pan and zoom, a resize or new
`width` / `height`, hiding a legend entry, and a new spec (a new spec is a new chart). If such a change arrives while a
transition runs, it becomes the transition's new end: the marks keep moving on the same clock and land on the scene with both
changes, instead of jumping.

New data during a transition starts the next transition from the frame on screen, not from where the last one started or
would have ended. A stream that delivers scenes faster than `duration` therefore never jumps, but it is always catching up:
for a high-rate stream, use a short `duration` or leave `transition` off.

## How items are matched

Each mark's items in the old and the new scene are paired:

- by the mark's **`key`** when it has one: Vega's mark `key` property, Vega-Lite's `key` encoding channel
  (`encoding: { key: { field: 'id' } }`). An item keeps its identity however the rows are reordered, added or removed;
- otherwise **by index** within the mark, as Vega does without a key: the first bar becomes the first bar.

The group items of a faceted mark (a Vega-Lite line chart with `color`, a facet) are paired by the facet's `groupby` values (or
the group mark's `key`), and nested marks inside them by their place. Axis grid lines, ticks and labels are paired by the tick
value they stand for.

## Enter, update, exit

| | update (in both scenes) | enter (new) | exit (gone) |
|---|---|---|---|
| rect whose mark shares a baseline (a bar chart) | position, size and paint move | grows out of the baseline | shrinks into the baseline, then is removed |
| any other mark item (a stack's segments, heatmap cells, symbols, text, rules, arcs) | position, size, angles, radii and paint move | fades in where it will be | fades out where it was, then is removed |
| line, area, trail | point by point, when the series has as many points in both scenes; otherwise it is drawn as the new scene has it | the series fades in | the series fades out |
| axis ticks, labels, grid lines | slide to their new position | fade in at their new position | fade out at their old position |
| axis domain line and title | move | | |
| legends, chart titles | drawn as the new scene has them | | |

What moves: `x`, `y`, `x2`, `y2`, `width`, `height`, `size`, `angle`, `radius`, `innerRadius`, `outerRadius`, `startAngle`,
`endAngle`, `padAngle`, `cornerRadius`, `strokeWidth`, `fontSize`, `dx`, `dy`, `opacity`, `fillOpacity`, `strokeOpacity`,
and `fill` / `stroke` colours (mixed in RGB). Anything else, such as text content, a symbol's shape, a path, a gradient or a
colour that does not parse, is the new scene's from the first frame. "A shared baseline" means every rect of the mark sits on
the same bottom (or top, left, right) edge, as the bars of a bar chart sit on zero; the segments of a stack and the cells of a
heatmap do not, so they fade.

The last frame of every transition is the new scene itself: once it settles, the DOM is exactly what a chart without
`transition` (or a fresh mount) draws. The tests compare the `outerHTML`.

## During a transition

Only the drawn SVG moves. Hit testing, tooltips, point selection, `signal.on` events and the accessible tree answer for the
new scene from the start, so a click lands on where a bar is going, not on where it is drawn this frame. The hit index and
the accessible tree are built once per scene, never per frame.

Frames are drawn from `requestAnimationFrame` by the DOM patcher, outside React: a frame re-renders no component. Unmounting the
chart, giving it another spec, or switching it to the canvas renderer stops the frames. Server rendering ignores the prop.

## What does not animate

- The canvas renderer (`renderer="canvas"`) draws the new scene at once.
- Batched dense marks (`denseMarks`, by default a symbol mark of 512 items or more) are drawn at once.
- `incremental={false}` (string markup on every update) is drawn at once.
- A change that would move more than `maxItems` items (default 1,000) is drawn at once. Planning stops at the first item past
  the limit, so a large change costs little before it is drawn.

## Loading and cost

The interpolation is its own module, `@aster-charts/core/transition`, and a chart loads it on demand: an app that never sets
`transition` never fetches it, and a chart that sets it starts loading it at once, so the first change of data can animate. A
change that arrives before it has loaded is drawn at once. The module is 3.7 kB gzip on top of `@aster-charts/core` (with `maxItems` and `drawsSame`, measured 2026-11-10); the prop
handling adds about 1.2 kB gzip to the eager `<Chart>` bundle (`pnpm --filter @aster-charts/benchmarks run budget`, measured
2026-11-09; the breakdown is in [PERFORMANCE.md](PERFORMANCE.md#bundle-sizes)).

A frame costs about what drawing the new scene at once costs, once per animation frame: every moving item gets a new element
description and the browser restyles it. `pnpm --filter @aster-charts/benchmarks run bench:transition` (headless Chromium; a
transition in which every item moves and recolours: one plan, then 30 frames from `requestAnimationFrame`, each `at(t)` +
`patchSceneDom`; three runs, the range of the per-run medians), measured 2026-11-09:

| scene | planning (once) | script per frame | frame interval | one patch without transition |
|---|---|---|---|---|
| 1,000 symbols | 5.4–5.6 ms | 3.6–3.8 ms | 16.7 ms (60 fps) | 4.7–5.4 ms |
| 10,000 symbols | 28.3–30.3 ms | 31.0–31.2 ms | 66.7 ms (15 fps) | 34.6–35.9 ms |
| 1,000 rects | 4.0–4.3 ms | 1.7 ms | 16.7 ms (60 fps) | 2.0–2.1 ms |
| 10,000 rects | 25.5–29.0 ms | 11.7–12.9 ms | 33.3 ms (30 fps) | 16.0–17.0 ms |

A thousand moving items keep 60 frames a second there; ten thousand drop frames (the transition still takes its `duration` and
ends on the exact scene, in fewer frames). That is where the default `maxItems` of 1,000 comes from: past it a change is drawn
at once. Raise it for a chart that can afford the frames, or lower it for a chart whose data changes often.

A scene that is not a change of data arriving during a transition (a Vega-Lite `time` animation's clock ticking between two
frames, a signal no mark reads) is first compared with the transition's end (`drawsSame`): when it draws the same, the
transition keeps its plan and settles on it, and only a scene that draws differently is planned again. The comparison does
not look into what the two scenes share by identity. `pnpm --filter @aster-charts/benchmarks run bench:transition-retarget`
(1,000 keyed rects in Node, median of 40 calls, three rounds, 2026-11-10): planning again 1.01–1.13 ms; the comparison
0.18–0.27 ms when the scenes share no object, and 0.001–0.002 ms when they share the mark.

A `<ChartStream>` that brings new data more often than `duration`
interrupts each transition with the next one, which starts from the frame on screen; the marks keep moving and land on the
latest data a `duration` after it stops changing. For a fast stream, a short `duration` keeps the picture close to the data.

## The core API

`@aster-charts/core/transition` works on scenes and has no clock; a non-React host drives it from its own frame loop:

```ts
import { patchSceneDom } from '@aster-charts/core/dom'
import { createSceneTransition } from '@aster-charts/core/transition'

const tr = createSceneTransition(shownScene, nextScene, { easing: 'cubic-in-out' })
const start = performance.now()
const frame = (now: number) => {
  const t = (now - start) / 300
  patchSceneDom(svg, tr.at(t)) // t >= 1 is nextScene itself
  if (t < 1) requestAnimationFrame(frame)
}
if (tr.moves) requestAnimationFrame(frame)
else patchSceneDom(svg, nextScene)
```

`tr.at(t)` returns one scene object rewritten in place by every call below 1: draw it before asking for the next. To
interrupt, make the next transition from the frame on screen (`createSceneTransition(tr.at(t), newer)`). `createScenePlayer(paint,
report, shown?)` is that loop, ready made: `draw(target, scene, { duration, easing } | null)` animates from what is on screen (or,
with `null`, retargets a running transition or draws at once), `reset(scene)` and `cancel()` stop it; it is what `<Chart>` uses.
`easingFunction(easing)` and `EASING_NAMES` resolve and list the named curves.
