// A prop added to ChartProps with no decision for <SvgChart> must break parity.assert.ts.
import '../src/parity.assert.js'
declare module '../src/chart-types.js' {
  interface ChartProps { aNewChartProp?: string }
}
