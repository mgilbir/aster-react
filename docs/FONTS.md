# Fonts and text measurement

Layout depends on text widths (axis and legend sizes, title placement, label overlap). The engine
measures text the way `vega-scenegraph` does (`packages/core/src/text-metrics.ts`):

1. **A host provider**, if one is set (below).
2. Otherwise **canvas `measureText`** when a canvas 2D context exists (a browser page, or jsdom with the
   `canvas` package): the width is measured with the item's font string
   (`[style ][variant ][weight ]{size}px {family}`), cached by font and text. This is what Vega does in a
   browser, so a chart laid out in Chromium matches Vega's layout in Chromium.
3. Otherwise (Node, SSR, jsdom without canvas) the **headless estimate**, `~~(0.8 x text.length x fontSize)`,
   which is what Vega falls back to without a canvas. It is deterministic across machines.

Implications:

- The same spec can lay out differently in a browser (measured widths) and on the server (estimated widths).
  If the SVG you render on the server must match the client's layout, give both sides the same provider
  (a table of advance widths, for example) or render on one side only.
- With the estimate, a custom `font` / `fontFamily` changes paint and wrapping rules but not the advance
  width. If you need pixel-accurate text without a canvas, supply a provider that measures with your own engine.
- The browser conformance gate (`pnpm conformance:browser`) runs real Vega and Aster in Chromium with live
  canvas metrics; the Node corpus gates run both sides on the headless estimate. See
  [TESTING.md](TESTING.md).
- Prefer system font stacks or bundle the font in the host CSS; the SVG carries the `font-family` value but never
  embeds font files.

## Custom measurement

```ts
import { renderSpec, withTextMetricsProvider, type TextMetricsProvider } from '@aster/core'

const provider: TextMetricsProvider = {
  // text, the CSS font string, the font size in px, and the scene item's font properties
  measure: (text, _font, fontSize) => text.length * fontSize * 0.6,
}
// per call
const svg = renderSpec({ width: 100, height: 40, marks: [] }, { textMetrics: provider })
// or for a whole block
const svg2 = withTextMetricsProvider(provider, () => renderSpec({ width: 100, height: 40, marks: [] }))
```

`<Chart textMetrics={provider}>` and `useChart` take the same provider; `setTextMetricsProvider(provider | null)`
installs one globally (and clears the width cache). A provider that throws, or returns a negative or non-finite
width, falls back to the headless estimate for that string. Widths are cached by provider, font string and text.
For workers, register the provider under a name with `registerWorkerTextMetrics` and pass the name (see
[API.md](API.md)).

Accessible captions use the same plain text as the rendered labels, with abbreviations expanded for temporal
scales (`%a` to `%A`, `%b` to `%B`), matching Vega's screen-reader formatting.
