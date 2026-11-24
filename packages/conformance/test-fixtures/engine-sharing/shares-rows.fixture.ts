// Two spec objects, but one rows array: the guard must fail this test too (what is shared is the rows vega writes onto).
import { it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { stackedSpec } from './spec.js'

it('shares the rows between the engines', async () => {
  const spec = stackedSpec()
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  await view.runAsync()
  view.finalize()
  renderSpec({ ...spec, data: [{ ...(spec.data as object[])[0] }] } as never)
})
