import {readFileSync} from 'node:fs'
import {canonicalizeSvg} from '../src/normalize.js'
const a:any=canonicalizeSvg(readFileSync('/tmp/case-oracle.svg','utf8'))
const b:any=canonicalizeSvg(readFileSync('/tmp/case-ours.svg','utf8'))
for(const i of [14,15,16,17]) console.log(i, JSON.stringify(a.records[i]), '|', JSON.stringify(b.records[i]))
