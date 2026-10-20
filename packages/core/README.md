# @aster/core

A small TypeScript Vega/Vega-Lite rendering engine on owned D3 primitives. Compiles a
Vega spec to an IR, evaluates data/scales/encodes into a renderer-neutral scene, and
renders SVG (or canvas via the addon).

```ts
import { renderSpec } from '@aster/core'
const svg = renderSpec(spec, { width: 400, height: 300, limits: { maxTimeMs: 2000 } })
```

Addons: `@aster/core/dom` (incremental DOM + sessions), `/canvas`, `/hit`, `/signals`,
`/load` (URL datasets), `/geo`, `/transforms`.

See the [repository documentation](https://github.com/mgilbir/aster-react#readme),
especially `docs/API.md`, `docs/LIMITS.md` and `docs/ERRORS.md`.
