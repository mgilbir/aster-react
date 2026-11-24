// The same comparison through forEngines: each engine its own copy. The guard must pass it.
import { it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { forEngines } from '../../src/engines.js'
import { stackedSpec } from './spec.js'

it('gives each engine its own copy', async () => {
  await forEngines(stackedSpec(), async (oracle, aster) => {
    const view = new vega.View(vega.parse(oracle as never), { renderer: 'none' })
    await view.runAsync()
    view.finalize()
    renderSpec(aster as never)
  })
})
