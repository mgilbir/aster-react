/**
 * The public `evaluateChart`: the runtime's, with the incremental engine registered. Evaluating a chart again with `dataChanges` /
 * `dataPulse` (see docs/API.md) is incremental, which needs the engine; importing it here keeps the function's behaviour whatever a
 * bundle imports besides, while `renderSpec` (which evaluates once) does not pull it in.
 */
import './incremental-register.js'

export { evaluateChart } from './runtime.js'
