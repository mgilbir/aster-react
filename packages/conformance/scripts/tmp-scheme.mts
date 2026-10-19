import {scheme} from '../../core/src/scale.ts'
const x:any=scheme('category10')
console.log(typeof x, Array.isArray(x), Array.isArray(x)?x.slice(0,10):String(x).slice(0,200))
