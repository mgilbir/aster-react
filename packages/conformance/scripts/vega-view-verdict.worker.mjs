// Worker for differential-signal-cycles: builds a vega View of each spec it is sent and answers with the outcome. vega's
// rerank can loop for ever on some cycles: the test terminates this worker past a deadline and counts the spec as a hang.
import { parentPort } from 'node:worker_threads'
import * as vega from 'vega'

parentPort.on('message', ({ id, spec }) => {
  let verdict
  try {
    new vega.View(vega.parse(spec), { renderer: 'none' }).finalize()
    verdict = 'ok'
  } catch (e) {
    verdict = e && e.message === 'Cycle detected in dataflow graph.' ? e.message : 'other: ' + (e && e.message)
  }
  parentPort.postMessage({ id, verdict })
})
