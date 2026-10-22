# @aster/vl

A from-scratch Vega-Lite → Vega compiler verified against the vega-lite oracle by
rendering parity.

Use it directly:

```ts
import { compile } from '@aster/vl'
const vegaSpec = compile(vegaLiteSpec)
```

or let `<Chart>`/`useChart` do it by registering the addon once:

```ts
import '@aster/react/vl'
```

`@aster/react` is Vega-only by default (the compiler is ~23 kB gzip); the addon is
the opt-in boundary, mirroring `@aster/core/dom` and `@aster/core/transforms`.
