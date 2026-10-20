# @aster/vl

A from-scratch Vega-Lite → Vega compiler verified against the vega-lite oracle by
rendering parity. `<Chart>` and `useChart` in `@aster/react` call it automatically for
Vega-Lite input.

```ts
import { compile } from '@aster/vl'
const vegaSpec = compile(vegaLiteSpec)
```
