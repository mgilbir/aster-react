# Fonts and text measurement

The engine reproduces Vega's headless text metric, not a browser's font rasterizer:
width is estimated as `~~(0.8 × text.length × fontSize)` and line height from the
mark/config. That is what keeps the SVG string deterministic across server and
browser.

Implications:

- Axis/legend layout is stable even when the declared font is unavailable.
- A custom `font`/`fontFamily` changes paint and wrapping rules, but not the estimated
  advance width. If you need pixel-perfect browser text, measure in the host and feed
  explicit sizes/limits or use the canvas renderer with your own text pass.
- The browser conformance gate (`pnpm conformance:browser`) uses live Chromium text
  metrics for the oracle and still matches the engine's estimator because both sides
  are normalized to the same semantic records.
- Prefer system font stacks or bundle the font in the host CSS; the SVG carries the
  `font-family` value but never embeds font files.
- For custom/non-browser font engines, pass `textMetrics` to `<Chart>`/`renderSpec` or
  call `setTextMetricsProvider({ measure(text, font, size) {…} })`. Providers are
  scoped to one evaluation, cache-keyed, and fall back to the headless estimate when
  they throw or return an invalid width.

Accessible captions use the same plain text as the rendered labels, with abbreviations
expanded for temporal scales (`%a`→`%A`, `%b`→`%B`), matching Vega's screen-reader
formatting.
