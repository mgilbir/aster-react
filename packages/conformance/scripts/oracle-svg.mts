import * as vega from 'vega'
import * as fs from 'node:fs'
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
await view.runAsync()
fs.writeFileSync(process.argv[3], await view.toSVG())
view.finalize()
console.log('written')
