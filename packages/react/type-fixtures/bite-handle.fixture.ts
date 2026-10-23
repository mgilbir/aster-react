// A method added to ChartHandle with no decision for <SvgChart>'s ref must break parity.assert.ts.
import '../src/parity.assert.js'
declare module '../src/chart-types.js' {
  interface ChartHandle { aNewHandleMethod(): void }
}
