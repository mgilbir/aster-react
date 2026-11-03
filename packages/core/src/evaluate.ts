/**
 * The public `evaluateChart`: an evaluation that keeps its state for the next one, and so is handed the incremental engine.
 * Evaluating a chart again with `dataChanges` / `dataPulse` (see docs/API.md) is incremental, which needs the engine; passing it here
 * keeps the function's behaviour whatever a bundle imports besides, while `renderSpec` (which evaluates once, `evaluateOnce`) does not
 * pull it in.
 */
import { evaluateChartPending } from './runtime.js'
import { incrementalEngine } from './incremental-engine.js'
import type { CompiledChart, RuntimeInput, SceneRoot } from './types.js'

export function evaluateChart(chart: CompiledChart, input: RuntimeInput = {}): SceneRoot {
  const pending = evaluateChartPending(incrementalEngine, chart, input)
  pending.commit()
  return pending.scene
}
