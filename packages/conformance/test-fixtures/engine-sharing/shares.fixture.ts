// Hands ONE spec object to vega, then to Aster: the guard must fail this test (vega has written y0/y1 onto the rows Aster reads).
import { it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { stackedSpec } from './spec.js'

it('shares one spec between the engines', async () => {
  const spec = stackedSpec()
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  await view.runAsync()
  await view.toSVG()
  view.finalize()
  renderSpec(spec as never)
})
