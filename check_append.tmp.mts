import { createChartStream, compileChart, evaluateChart } from './packages/core/src/index.ts'
import { renderSceneToCanvasAppend, snapshotCanvasScene } from './packages/core/src/canvas.ts'
const spec:any={width:800,height:500,padding:0,autosize:'none',background:'white',data:[{name:'t',values:[]}],scales:[{name:'x',type:'linear',domain:[0,1],range:[0,800]},{name:'y',type:'linear',domain:[0,10],range:[500,0]}],axes:[{scale:'x',orient:'bottom',grid:true},{scale:'y',orient:'left',grid:true}],marks:[{type:'symbol',from:{data:'t'},encode:{update:{x:{scale:'x',field:'x'},y:{scale:'y',field:'y'},size:{value:8}}}}]}
const rows=(n:number,from=0)=>Array.from({length:n},(_,i)=>({x:((from+i)%1000)/1000,y:(((from+i)*7)%100)/10}))
const s=createChartStream(spec,{initial:{data:{t:rows(1000)}}})
const f1=s.flush()!
const snap=snapshotCanvasScene(f1.scene)
console.log('scene items',f1.scene.items.map((g:any)=>({role:g.role,mt:g.marktype,n:g.items?.length,gen:g.__gen})))
console.log('snap lengths',[...snap.markLengths.values()], 'gen',snap.gen, 'sceneGen',(f1.scene as any).__itemGen)
s.push({append:{t:rows(1,1000)}})
const f2=s.flush()!
console.log('after',f2.scene.items.map((g:any)=>({role:g.role,mt:g.marktype,n:g.items?.length,gen:g.__gen})))
const mark:any=f2.scene.items.find((g:any)=>g.role==='mark')
console.log('last item gen',mark.items[1000].__gen,'first gen',mark.items[0].__gen)
const fake:any=new Proxy({save(){},restore(){},translate(){},scale(){},beginPath(){},moveTo(){},lineTo(){},bezierCurveTo(){},quadraticCurveTo(){},arc(){},closePath(){},rect(){},clip(){},fill(){},stroke(){},fillRect(){},setLineDash(){},fillText(){},createLinearGradient(){return {addColorStop(){}}},globalAlpha:1,lineWidth:1,font:'',textAlign:'',textBaseline:'',lineCap:'butt',lineJoin:'miter',miterLimit:4},{get(t,k){return k in t?t[k]:()=>{}},set(t,k,v){t[k]=v;return true}})
console.log('append result', renderSceneToCanvasAppend(snap, f2.scene, fake, {dpr:1}))
