import {hcl,rgb} from '../../core/src/color.ts'
function interpolateHclStrings(a: string, b: string): (t: number) => string {
  const A = hcl(a), B = hcl(b)
  const dh = B.h - A.h
  const hStep = dh > 180 || dh < -180 ? dh - 360 * Math.round(dh / 360) : dh
  return (t) => hcl(A.h + t * hStep, A.c + t * (B.c - A.c), A.l + t * (B.l - A.l), A.opacity + t * (B.opacity - A.opacity)).formatRgb()
}
const palette=['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf']
const n=palette.length-1
const segs=palette.slice(0,-1).map((c,i)=>interpolateHclStrings(c,palette[i+1]!))
function f(t:number){if(t<=0)return rgb(palette[0]!).formatRgb(); if(t>=1)return rgb(palette[n]!).formatRgb(); const i=Math.min(Math.floor(t*n),n-1); return segs[i]!(t*n-i)}
for (const t of [0,1/3,2/3,1,6/9]) console.log(t,t*9,f(t))
console.log('hcl pink0', interpolateHclStrings('#e377c2','#7f7f7f')(0))
console.log('hcl brown1', interpolateHclStrings('#8c564b','#e377c2')(1))
