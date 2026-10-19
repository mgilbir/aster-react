import {hcl,lab,rgb} from '../../core/src/color.ts'
for (const s of ['#e377c2','#7f7f7f','#d62728','#8c564b','#ff9da6','#fdc086']) {
 const h:any=hcl(s), l:any=lab(s), r:any=rgb(s)
 console.log(s,'lab',l.l,l.a,l.b,'hcl',h.h,h.c,h.l,'back',h.formatRgb())
}
