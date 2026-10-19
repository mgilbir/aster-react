import {scheme} from '../../core/src/scale.ts'
const f:any=scheme('blues')
for(const t of [-0.8,-0.5,0,0.2,0.5,1,1.2,1.8,2]) console.log(t, f(t))
