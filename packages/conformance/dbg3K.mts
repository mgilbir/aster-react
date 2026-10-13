import { compileChart, evaluateChart } from '@aster/core'
import { compile } from '@aster/vl'
import { readFileSync } from 'node:fs'
const doc = JSON.parse(readFileSync('corpus/log-scale.vl.json', 'utf8'))
const out = compile(doc.spec ?? doc)
console.log('y scale spec:', JSON.stringify((out.scales as any[]).find((s) => s.name === 'y')))
const cm = compileChart(out as never)
const scene = evaluateChart(cm, {})
const find = (n: any, acc: any[] = []): any[] => {
  if ((n as any).marktype === 'group' && (n as any).items?.[0]?.items) acc.push(n)
  for (const c of n.items ?? []) if (c.items) find(c, acc)
  return acc
}
