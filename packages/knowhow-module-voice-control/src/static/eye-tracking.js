import {FaceLandmarker,FilesetResolver} from '/vendor/vision_bundle.mjs';
const $=id=>document.getElementById(id), stage=$('stage'), gaze=$('gaze'), metrics=$('metrics'), result=$('result'), banner=$('banner'), hud=$('hud');
const NL=String.fromCharCode(10);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const setStatus=s=>{$('status').textContent=s};
const median=a=>{if(!a.length)return NaN;const v=[...a].sort((x,y)=>x-y);return v[v.length>>1]};
const avg=a=>a.length?Math.round(a.reduce((s,v)=>s+v,0)/a.length):0;
// cams[i]: {video,stream,landmarker,label,deviceId,lastTime,f,lm,t,opens,irisBuf,fps,fpsCount,fpsT,stat}
const cams=[];
let latest=null,frameId=0;
let screens=[],store={version:4,monitors:{}},model=null,smoothed=null,lastPost=0,gazePosting=false,savingNow=false,liveMon=-1,epoch=null,serverOk=true;
let phase='setup',session=null; // session: {key,rect,label,index,samples,stop,paused,test,run}



// ---- features (keep identical to eyeTrackingWorker.py, FEATURE_VERSION 4) ----
// Per eye: iris offset from the eye-corner midpoint in eye widths. Eyes are kept separate because
// when you look far to one side the far eye's iris is foreshortened by the nose and the other eye is
// the better signal; the regression learns how to weight them.
function feature(l){
  if(!l||l.length<478)return null;
  const d=(a,b)=>Math.max(1e-4,Math.hypot(l[b].x-l[a].x,l[b].y-l[a].y));
  const eye=(iris,a,b,top,bot)=>{const w=d(a,b),cx=(l[a].x+l[b].x)/2,cy=(l[a].y+l[b].y)/2;return [(l[iris].x-cx)/w,(l[iris].y-cy)/w,(l[iris].y-(l[top].y+l[bot].y)/2)/w,(l[bot].y-l[top].y)/w]};
  const r=eye(468,33,133,159,145),e=eye(473,362,263,386,374),fw=d(234,454);
  return [r[0],r[1],e[0],e[1],(r[2]+e[2])/2,(r[3]+e[3])/2,
    (l[1].x-(l[234].x+l[454].x)/2)/fw,(l[1].y-(l[10].y+l[152].y)/2)/fw,((l[234].z||0)-(l[454].z||0))/fw,
    Math.atan2(l[263].y-l[33].y,l[263].x-l[33].x),(l[234].x+l[454].x)/2,(l[10].y+l[152].y)/2,fw];
}
const irisX=f=>(f[0]+f[2])/2, irisY=f=>(f[1]+f[3])/2;
// Only raw 0..8 enter the model. Roll, face position in the frame and face size (9..12) drift with posture
// over a session; training on them made the model read "leaned back / sank lower" as "looking lower".
const MODEL_RAW=9;
function expand(f){const mx=irisX(f),my=irisY(f);return f.slice(0,MODEL_RAW).concat([mx*mx,my*my,mx*my,mx*f[6],my*f[7]])}
// A frame c is a per-camera list of raw features (null = that camera has no face). A variant key such as
// "01" or "1" lists the cameras whose expanded features are concatenated.
const has=(c,key)=>[...key].every(k=>c[Number(k)]);
function vec(c,key){let v=[];for(const k of key)v=v.concat(expand(c[Number(k)]));return v}
function applyModel(m,e){let x=m.wx[0],y=m.wy[0];const z=new Float64Array(e.length);for(let i=0;i<e.length;i++){z[i]=(e[i]-m.mean[i])/m.std[i];x+=m.wx[i+1]*z[i];y+=m.wy[i+1]*z[i]}
  const k=m.krr;if(k)for(let j=0;j<k.C.length;j++){const c=k.C[j];let d=0;for(let i=0;i<z.length;i++)d+=(z[i]-c[i])**2;const w=Math.exp(-k.gamma*d);x+=w*k.ax[j];y+=w*k.ay[j]}
  return {x,y}}
// Prefer the variant that uses the most cameras, then the one with the lower cross-validated error.
function variantOrder(vs){return Object.keys(vs).sort((a,b)=>b.length-a.length||(vs[a].cvErrorPx??1e9)-(vs[b].cvErrorPx??1e9)||(a<b?-1:1))}
function predictWith(vs,c){if(!vs)return null;for(const k of variantOrder(vs))if(has(c,k)){const p=applyModel(vs[k],vec(c,k));p.v=k;return p}return null}
// Head direction (noseX offset + yaw, per camera) picks the monitor; that monitor's own model estimates the point.
const HEAD=[6,8];
function route(m,c,prev){
  if(!m||!m.perMonitor||m.perMonitor.length<2)return -1;
  const ds=m.perMonitor.map(p=>{let s=0,n=0;c.forEach((f,i)=>{if(!f||!p.head[i]||!m.headSd[i])return;HEAD.forEach((h,j)=>{s+=((f[h]-p.head[i][j])/m.headSd[i][j])**2});n++});return n?s/n:Infinity});
  let best=0;ds.forEach((d,i)=>{if(d<ds[best])best=i});
  if(!Number.isFinite(ds[best]))return -1;
  // Hysteresis: only switch away from the current monitor when the other one is clearly closer.
  if(prev>=0&&prev<ds.length&&best!==prev&&Number.isFinite(ds[prev])&&ds[best]>0.6*ds[prev])return prev;
  return best;
}
// Drift correction: a per-monitor offset measured by Recenter (or an accuracy test) and added after the model.
// m.bias = [{key, monitor:{x,y,width,height}, dx, dy}]. Lookup by monitor key, or by the rect containing the point.
function biasFor(m,key,x,y){const b=m&&m.bias;if(!b||!b.length)return null;
  return b.find(e=>key!=null?e.key===key:(x>=e.monitor.x&&x<e.monitor.x+e.monitor.width&&y>=e.monitor.y&&y<e.monitor.y+e.monitor.height))||null}
function predict(m,c,prev){
  if(!m||!c||!c.some(Boolean))return null;const i=route(m,c,prev===undefined?-1:prev);
  if(i>=0){const pm=m.perMonitor[i],r=pm.monitor,p=predictWith(pm.variants,c);
    if(p){const b=biasFor(m,pm.key);if(b){p.x+=b.dx;p.y+=b.dy}
      return {x:Math.min(r.x+r.width-1,Math.max(r.x,p.x)),y:Math.min(r.y+r.height-1,Math.max(r.y,p.y)),mon:i,v:p.v}}}
  const p=predictWith(m.variants,c);if(!p)return null;p.mon=-1;
  const b=biasFor(m,null,p.x,p.y);if(b){p.x+=b.dx;p.y+=b.dy}return p;
}
function solveSym(M,b){const n=b.length,A=M.map((r,i)=>r.concat([b[i]]));for(let i=0;i<n;i++){let p=i;for(let k=i+1;k<n;k++)if(Math.abs(A[k][i])>Math.abs(A[p][i]))p=k;[A[i],A[p]]=[A[p],A[i]];const dv=A[i][i]||1e-9;for(let j=i;j<=n;j++)A[i][j]/=dv;for(let k=0;k<n;k++)if(k!==i){const f=A[k][i];if(f)for(let j=i;j<=n;j++)A[k][j]-=f*A[i][j]}}return A.map(r=>r[n])}
// Weighted ridge on standardized features with an unpenalized intercept. Sufficient statistics are kept
// per dot (group), so leave-one-dot-out cross-validation over every dot and every lambda is cheap.
// wantDotErr: also record each dot's leave-one-dot-out error (used to seed the training coverage map).
let wantDotErr=false,dotErrs=null;
function fitVariant(all,key){
  const rows=all.filter(r=>has(r.c,key));if(rows.length<20)return null;
  const E=rows.map(r=>vec(r.c,key)),W=rows.map(r=>r.w||1),n=E[0].length,sw=W.reduce((a,b)=>a+b,0);
  const mean=Array(n).fill(0),std=Array(n).fill(0);
  E.forEach((e,k)=>e.forEach((v,i)=>{mean[i]+=W[k]*v/sw}));
  E.forEach((e,k)=>e.forEach((v,i)=>{std[i]+=W[k]*(v-mean[i])**2/sw}));
  for(let i=0;i<n;i++)std[i]=Math.max(1e-6,Math.sqrt(std[i]));
  const D=n+1,mk=()=>({G:Array.from({length:D},()=>new Float64Array(D)),bx:new Float64Array(D),by:new Float64Array(D),sa:new Float64Array(D),cnt:0,tx:0,ty:0});
  const groups=new Map(),T=mk();
  E.forEach((e,k)=>{const r=rows[k],w=W[k],a=[1].concat(e.map((v,i)=>(v-mean[i])/std[i]));let g=groups.get(r.g);if(!g){g=mk();g.tx=r.x;g.ty=r.y;groups.set(r.g,g)}
    for(const S of [g,T]){for(let i=0;i<D;i++){const wi=w*a[i];S.bx[i]+=wi*r.x;S.by[i]+=wi*r.y;const Gi=S.G[i];for(let j=i;j<D;j++)Gi[j]+=wi*a[j]}S.cnt++}
    for(let i=0;i<D;i++)g.sa[i]+=a[i]});
  const pen=sw/rows.length;
  const solve=(lambda,minus)=>{const M=[],bx=[],by=[];for(let i=0;i<D;i++){M.push([]);for(let j=0;j<D;j++){const ii=Math.min(i,j),jj=Math.max(i,j);M[i].push(T.G[ii][jj]-(minus?minus.G[ii][jj]:0)+(i===j&&i>0?lambda*pen:0))}
      bx.push(T.bx[i]-(minus?minus.bx[i]:0));by.push(T.by[i]-(minus?minus.by[i]:0))}return {wx:solveSym(M,bx),wy:solveSym(M,by)}};
  let best=10,bestErr=Infinity;const gl=[...groups.values()];
  if(gl.length>=5){for(const lambda of [0.3,1,3,10,30,100,300]){let err=0;
      // Score each held-out dot by its mean prediction, matching how the accuracy test scores a fixation.
      for(const g of gl){const s=solve(lambda,g);let px=0,py=0;for(let i=0;i<D;i++){px+=s.wx[i]*g.sa[i];py+=s.wy[i]*g.sa[i]}err+=Math.hypot(px/g.cnt-g.tx,py/g.cnt-g.ty)}
      if(err/gl.length<bestErr){bestErr=err/gl.length;best=lambda}}}
  if(wantDotErr){dotErrs=gl.map(g=>{const q=solve(best,g);let px=0,py=0;for(let i=0;i<D;i++){px+=q.wx[i]*g.sa[i];py+=q.wy[i]*g.sa[i]}return {x:g.tx,y:g.ty,e:Math.hypot(px/g.cnt-g.tx,py/g.cnt-g.ty)}})}
  const s=solve(best,null);
  const out={mean,std,lambda:best,wx:s.wx,wy:s.wy,cvErrorPx:Number.isFinite(bestErr)?Math.round(bestErr):null,samples:rows.length,dots:gl.length};
  const k=fitKrr(gl,s,D,bestErr);if(k){out.krr=k.krr;out.ridgeCvErrorPx=out.cvErrorPx;out.cvErrorPx=k.cv}
  return out;
}
// Non-linear correction on top of the ridge map: RBF kernel ridge on each training dot's mean residual (one
// centre per dot, in standardized feature space). It bends the map where the linear+quadratic model is
// systematically off (centre vs edges). Offline on your test data it cut the offset-free error ~15-25 %.
// Lambda is picked by closed-form leave-one-dot-out; it is only kept when it beats the ridge CV.
const KRR_LAMBDAS=[0.1,0.3,1,3];
function invSym(M){const n=M.length,A=M.map((r,i)=>{const e=new Float64Array(2*n);for(let j=0;j<n;j++)e[j]=r[j];e[n+i]=1;return e});
  for(let i=0;i<n;i++){let p=i;for(let k=i+1;k<n;k++)if(Math.abs(A[k][i])>Math.abs(A[p][i]))p=k;[A[i],A[p]]=[A[p],A[i]];const dv=A[i][i]||1e-12;for(let j=0;j<2*n;j++)A[i][j]/=dv;
    for(let k=0;k<n;k++)if(k!==i){const f=A[k][i];if(f)for(let j=0;j<2*n;j++)A[k][j]-=f*A[i][j]}}
  return A.map(r=>Array.from(r.slice(n)))}
// Skipped while training (refits run after every dot); the save at the end of training refits with it.
let fastFit=false;
function fitKrr(gl,s,D,ridgeCv){
  if(fastFit||gl.length<30||!Number.isFinite(ridgeCv))return null;
  const n=gl.length,dim=D-1,gam=1/dim,C=[],rx=[],ry=[];
  for(const g of gl){const a=Array.from(g.sa,v=>v/g.cnt);let px=0,py=0;for(let i=0;i<D;i++){px+=s.wx[i]*a[i];py+=s.wy[i]*a[i]}C.push(a.slice(1));rx.push(g.tx-px);ry.push(g.ty-py)}
  const K=C.map(a=>C.map(b=>{let d=0;for(let i=0;i<dim;i++)d+=(a[i]-b[i])**2;return Math.exp(-gam*d)}));
  let best=null;
  for(const lam of KRR_LAMBDAS){const Hm=invSym(K.map((r,i)=>r.map((v,j)=>v+(i===j?lam:0))));
    const ax=Hm.map(r=>r.reduce((a,v,j)=>a+v*rx[j],0)),ay=Hm.map(r=>r.reduce((a,v,j)=>a+v*ry[j],0));
    let e=0;for(let i=0;i<n;i++)e+=Math.hypot(ax[i]/Hm[i][i],ay[i]/Hm[i][i]);e/=n;
    if(!best||e<best.e)best={e,lam,ax,ay}}
  if(!best||best.e>=0.97*ridgeCv)return null;
  const r4=v=>Math.round(v*1e4)/1e4;
  return {cv:Math.round(best.e),krr:{gamma:gam,lambda:best.lam,C:C.map(a=>a.map(r4)),ax:best.ax.map(r4),ay:best.ay.map(r4)}};
}
const ncamOf=rows=>Math.max(1,rows.reduce((a,r)=>Math.max(a,r.c.length),0));
function fitVariants(rows){const vs={};for(const k of (ncamOf(rows)>=2?['01','0','1']:['0'])){const m=fitVariant(rows,k);if(m)vs[k]=m}return Object.keys(vs).length?vs:null}
// Bump when fitting changes so pages refit saved models on load (2 = kernel correction layer).
const MODEL_FIT=2;
const bestCv=vs=>vs?vs[variantOrder(vs)[0]].cvErrorPx:null;

// Saved training that overlaps a connected monitor under a different geometry (e.g. a bogus window size captured
// mid-fullscreen) is ignored: it would otherwise win the head-direction routing and put the gaze on the wrong screen.
// Training for a monitor that is merely missing from the screen list is KEPT: Chrome sometimes reports an incomplete
// list right after a reload, and treating that as stale silently refit (and saved) a model without that monitor.
function staleKeys(){if(!screens.length||!screens[0].obj)return [];const live=new Set(screens.map(keyOf));
  return Object.keys(store.monitors).filter(k=>!live.has(k)&&screens.some(s=>overlaps(rectOf(s),store.monitors[k].monitor)))}
function monitorGroups(){const g={},stale=new Set(staleKeys());for(const [k,m] of Object.entries(store.monitors))if(!stale.has(k)&&(!session||session.test||k!==session.key))g[k]={monitor:m.monitor,rows:m.samples};
  if(session&&!session.test)g[session.key]={monitor:{x:session.rect.left,y:session.rect.top,width:session.rect.width,height:session.rect.height},rows:session.samples};return g}
function allRows(){return [].concat(...Object.values(monitorGroups()).map(g=>g.rows))}
// Combined model variants (fallback) plus, once 2+ monitors are trained, a head-direction router and per-monitor variants.
function fitAll(){
  const groups=monitorGroups(),rows=allRows(),variants=fitVariants(rows);if(!variants)return null;
  const N=ncamOf(rows),m={version:4,fit:fastFit?1:MODEL_FIT,ncam:N,variants,cvErrorPx:bestCv(variants),samples:rows.length,dots:new Set(rows.map(r=>r.g)).size};
  // Refits keep the current drift corrections (they describe today's posture, not the training data).
  const prevBias=typeof model==='undefined'?null:model&&model.bias;if(prevBias&&prevBias.length)m.bias=prevBias.filter(b=>groups[b.key]);
  const keys=Object.keys(groups).filter(k=>groups[k].rows.length>=20&&new Set(groups[k].rows.map(r=>r.g)).size>=5);
  if(keys.length>=2){
    const range=[...Array(N)].map((_,i)=>i);
    m.headSd=range.map(i=>{const sd=HEAD.map(h=>{let s=0,n=0;keys.forEach(k=>{const v=groups[k].rows.filter(r=>r.c[i]).map(r=>r.c[i][h]);if(!v.length)return;const mu=v.reduce((a,b)=>a+b,0)/v.length;v.forEach(x=>{s+=(x-mu)**2;n++})});return n>=20?Math.max(1e-3,Math.sqrt(s/n)):null});return sd.every(v=>v!==null)?sd:null});
    m.perMonitor=keys.map(k=>{const rs=groups[k].rows,vs=fitVariants(rs);if(!vs)return null;
      return {key:k,monitor:groups[k].monitor,variants:vs,cvErrorPx:bestCv(vs),samples:rs.length,head:range.map(i=>{const v=rs.filter(r=>r.c[i]);return v.length>=20?HEAD.map(h=>v.reduce((a,r)=>a+r.c[i][h],0)/v.length):null})}}).filter(Boolean);
    if(m.perMonitor.length<2||!m.headSd.some(Boolean)){delete m.perMonitor;delete m.headSd}
    else{let e=0,n=0;m.perMonitor.forEach(p=>{if(p.cvErrorPx!=null){e+=p.cvErrorPx*p.samples;n+=p.samples}});m.routedCvErrorPx=n?Math.round(e/n):null}
  }
  return m;
}
const variantName=k=>k.length>1?'A+B':k==='0'?'A':'B';
const cvText=m=>!m?'':(m.routedCvErrorPx!=null?'per-monitor CV ≈ '+m.routedCvErrorPx+' px (combined '+m.cvErrorPx+')':m.cvErrorPx!=null?'CV ≈ '+m.cvErrorPx+' px':'')
  +(m&&m.variants&&Object.keys(m.variants).length>1?' · by camera: '+variantOrder(m.variants).map(k=>variantName(k)+' '+m.variants[k].cvErrorPx).join(', '):'');


// ---- monitors ----
const keyOf=r=>Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+'x'+Math.round(r.height);
async function loadScreens(){
  try{if(window.getScreenDetails){const d=await window.getScreenDetails();d.onscreenschange=()=>loadScreens().then(renderMonitors);
    screens=[...d.screens].sort((a,b)=>a.left-b.left||a.top-b.top).map((s,i)=>({left:s.left,top:s.top,width:s.width,height:s.height,label:s.label||(s.isPrimary?'Primary display':'Display'),obj:s,index:i}));return}}catch(e){console.warn('Screen details unavailable',e)}
  screens=[{left:screen.availLeft||0,top:0,width:screen.width,height:screen.height,label:'Current display (grant window-management permission to see all monitors)',obj:null,index:0}];
}
const screenAt=(x,y)=>screens.find(s=>x>=s.left&&x<s.left+s.width&&y>=s.top&&y<s.top+s.height);
function windowScreen(){return screenAt(screenX+outerWidth/2,screenY+outerHeight/2)||screens[0]}
function pageRect(){if(session&&document.fullscreenElement)return session.rect;return {left:screenX,top:screenY+(outerHeight-innerHeight),width:innerWidth,height:innerHeight}}
const toDesktop=(cx,cy,r=pageRect())=>({x:r.left+cx*r.width/innerWidth,y:r.top+cy*r.height/innerHeight});
const toLocal=(p,r=pageRect())=>({x:(p.x-r.left)*innerWidth/r.width,y:(p.y-r.top)*innerHeight/r.height});
const overlaps=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
const rectOf=r=>({x:r.left,y:r.top,width:r.width,height:r.height});
// Refuse to train/test/recenter on geometry that does not match a real monitor: this is how the bogus
// "0,0,1032x1376" monitor got into the saved training.
function rectProblem(rect){
  const want=rect.width/rect.height,got=innerWidth/innerHeight;
  if(Math.abs(got-want)>0.03*want)return 'The fullscreen window is '+innerWidth+'×'+innerHeight+' but the monitor reports '+rect.width+'×'+rect.height+'. Nothing was recorded – exit fullscreen, reload the page and try again.';
  if(screens.some(o=>keyOf(o)!==keyOf(rect)&&overlaps(rectOf(o),rectOf(rect))))return 'The monitor list is inconsistent (screens overlap). Reload the page and try again.';
  const clash=Object.entries(store.monitors).find(([k,m])=>k!==keyOf(rect)&&overlaps(m.monitor,rectOf(rect)));
  if(clash)return 'Saved training "'+clash[0]+'" overlaps this monitor. Remove that stale entry first (button in the monitor list).';
  return null;
}
function renderMonitors(){
  const here=windowScreen(),box=$('monitors');box.innerHTML='';
  screens.forEach((s,i)=>{const k=keyOf(s),m=store.monitors[k],dots=m?new Set(m.samples.map(x=>x.g)).size:0,row=document.createElement('div');
    const pm=model&&model.perMonitor&&model.perMonitor.find(p=>p.key===k),bias=biasFor(model,k);
    row.className='mon'+(s===here?' here':'');
    row.innerHTML='<div><b>Monitor '+(i+1)+'</b> · '+s.label+' <span class="muted">('+s.width+'×'+s.height+' at '+s.left+','+s.top+')'+(s===here?' · this window':'')+'</span><br>'+(m?'<span class="ok">✓ trained · '+dots+' dots'+(pm&&pm.cvErrorPx!=null?' · own-model CV ≈ '+pm.cvErrorPx+' px ('+Object.keys(pm.variants).map(v=>variantName(v)+' '+pm.variants[v].cvErrorPx).join(', ')+')':'')+'</span>'
      +'<br><span class="'+(bias?'muted':'todo')+'">'+(bias?'drift correction ('+bias.dx+', '+bias.dy+') px · '+new Date(bias.time).toLocaleTimeString()+(Date.now()-bias.time>3600000?' – stale, recenter':''):'no drift correction yet – press Recenter at the start of each session')+'</span>':'<span class="todo">not trained yet</span>')+'</div>';
    const btns=document.createElement('div');const ready=cams.some(c=>c.landmarker);
    const b=document.createElement('button');b.textContent=(m?'Keep training':'Train')+' '+(i+1);b.disabled=!ready;b.onclick=()=>train(i,false);btns.appendChild(b);
    if(m){const r=document.createElement('button');r.textContent='Recenter';r.title='7 quick dots that measure today’s offset (posture, seat) and correct it – nothing is retrained';r.disabled=!ready||!model;r.onclick=()=>recenter(i);btns.appendChild(r)}
    if(m){const f=document.createElement('button');f.className='secondary';f.textContent='Retrain fresh';f.title='Discard this monitor’s old samples (e.g. after you moved a camera or your seat) and start over';f.disabled=!ready;f.onclick=()=>{if(confirm('Discard '+dots+' saved dots for Monitor '+(i+1)+' and start fresh?'))train(i,true)};btns.appendChild(f)}
    const t=document.createElement('button');t.className='secondary';t.textContent='Test accuracy';t.disabled=!ready||!model;t.onclick=()=>testAccuracy(i);btns.appendChild(t);
    row.appendChild(btns);box.appendChild(row)});
  staleKeys().forEach(k=>{const m=store.monitors[k],row=document.createElement('div');row.className='mon';
    row.innerHTML='<div><b class="bad">Stale training</b> · '+(m.label||'')+' <span class="muted">('+k+' · '+new Set(m.samples.map(x=>x.g)).size+' dots) – matches no connected monitor, so it is ignored</span></div>';
    const rm=document.createElement('button');rm.className='secondary';rm.textContent='Remove';rm.onclick=()=>forgetMonitor(k);row.appendChild(rm);box.appendChild(row)});
  const trained=screens.filter(s=>store.monitors[keyOf(s)]).length;
  $('done').disabled=!model;
  if(cams.some(c=>c.landmarker)&&phase!=='training'&&phase!=='testing')setStatus(trained===screens.length?'All '+screens.length+' monitor(s) trained'+(model?' · '+cvText(model):'')+'. Start each session with Recenter on each monitor, then Done.':'Trained '+trained+' of '+screens.length+' monitors. Click Train for each monitor.');
}
async function forgetMonitor(k){if(!confirm('Remove saved training "'+k+'"? (A copy is archived on disk.)'))return;
  try{const out=await api('/api/calibration/forget',{epoch,key:k});if(out.store)store=out.store;model=fitAll();if(model)await api('/api/model',{epoch,model,cameras:camConfig()});result.textContent='Removed '+k+(out.archived?' (backup: '+out.archived+')':'')+'.';logEvent('forget-monitor',{monitor:k})}
  catch(e){result.textContent='Could not remove '+k+': '+e.message}renderMonitors()}

// ---- server store, health and session log ----
function serverState(ok,why){serverOk=ok;const el=$('server');el.style.display=ok?'none':'block';if(!ok)el.textContent='⚠ Tracker server unreachable'+(why?' ('+why+')':'')+' – training is NOT being saved. Restart: knowhow eye-tracking'}
async function api(path,body,timeoutMs=30000){let res;const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{res=await fetch(path,body===undefined?{signal:ctl.signal}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:ctl.signal})}catch(e){if(ctl.signal.aborted)throw new Error('tracker server did not answer within '+Math.round(timeoutMs/1000)+' s');serverState(false,'network');throw new Error('tracker server is not running ('+e.message+')')}finally{clearTimeout(timer)}
  serverState(true);const out=await res.json().catch(()=>({}));if(!res.ok){const err=new Error(out.error||('HTTP '+res.status));err.status=res.status;throw err}return out}
// One health probe at a time, with a timeout: a slow/hung server must not accumulate pending requests (Chrome fails them with ERR_INSUFFICIENT_RESOURCES).
let healthBusy=false;
let disconnectedMonitors=[];
setInterval(()=>{if(healthBusy||document.hidden)return;healthBusy=true;fetch('/api/health',{signal:AbortSignal.timeout(2500)}).then(r=>{serverState(r.ok,r.ok?'':'HTTP '+r.status);if(r.ok)r.json().then(h=>{disconnectedMonitors=(h.monitorStatus||[]).filter(s=>!s.connected&&Object.keys(store.monitors||{}).includes(s.key));const el=document.getElementById('display-notice');if(el){if(disconnectedMonitors.length){el.textContent='Warning: trained monitor(s) not connected: '+disconnectedMonitors.map(s=>(s.label||s.key)).join(', ')+'. Eye tracking may land on the wrong screen.';el.style.display='block'}else{el.style.display='none'}}}).catch(()=>{})}).catch(e=>serverState(false,e&&e.name==='TimeoutError'?'not answering':'network')).finally(()=>{healthBusy=false})},3000);
async function loadStore(){
  try{const s=await api('/api/calibration');if(s&&s.monitors)store=s;epoch=s.epoch||null}catch(e){result.textContent=e.message}
  model=store.model||null;if(store.warning)result.textContent=store.warning;
}
const logQueue=[];
// Every dot, accuracy test and session event is appended to sessions.jsonl with camera/eye quality stats for offline review.
// Single-flight: events queue up while one /api/log request is outstanding and go out together in the next batch.
let logBusy=false;
function logEvent(type,data){logQueue.push(Object.assign({type,time:Date.now(),cams:camStats()},data));if(logQueue.length>500)logQueue.shift();flushLog()}
function flushLog(){if(logBusy||!logQueue.length)return;logBusy=true;const batch=logQueue.splice(0);
  api('/api/log',{events:batch},15000).then(()=>{logBusy=false;flushLog()},()=>{logQueue.unshift(...batch);if(logQueue.length>500)logQueue.splice(0,logQueue.length-500);logBusy=false;setTimeout(flushLog,5000)})}
function camConfig(){return cams.map(c=>({label:c.label,deviceId:c.deviceId,width:c.video.videoWidth,height:c.video.videoHeight}))}
async function save(s=session){if(!s||!s.samples.length)return;const r=s.rect,body={epoch,monitor:{x:r.left,y:r.top,width:r.width,height:r.height},label:s.label,cameras:camConfig(),samples:s.samples,model};
  try{const out=await api('/api/calibration',body,60000);if(out.store)store=out.store;epoch=out.epoch||epoch;localStorage.removeItem('eyePending');s.saveError=null}
  catch(e){
    if(e.status===409){s.saveError='training was reset from another tab – these samples were discarded';s.stop=true;throw new Error(s.saveError)}
    if(e.status===422){s.saveError=e.message;s.stop=true;throw e}
    // Keep a local copy so a crashed/stopped server does not lose a long training run.
    try{localStorage.setItem('eyePending',JSON.stringify(body))}catch{}
    s.saveError=e.message;throw e}}
async function restorePending(){const raw=localStorage.getItem('eyePending');if(!raw)return;let body;try{body=JSON.parse(raw)}catch{localStorage.removeItem('eyePending');return}
  if(body.epoch!==epoch){localStorage.removeItem('eyePending');return}
  try{const out=await api('/api/calibration',body);if(out.store)store=out.store;model=body.model||model;localStorage.removeItem('eyePending');result.textContent='Recovered '+body.samples.length+' unsaved training samples from the last session.'}catch{}}
async function loadHistory(){try{const list=await api('/api/accuracy');if(!Array.isArray(list)||!list.length){$('history').innerHTML='';return}
  const rows=list.slice(-12).reverse().map(t=>{const s=t.summary||{};return '<tr><td>'+new Date(t.time).toLocaleString()+'</td><td>'+(t.monitorIndex+1)+'</td><td>'+(t.cameras?t.cameras.length:1)+'</td><td>'+s.median+'</td><td>'+s.mean+'</td><td>'+s.p90+'</td><td>'+s.inBox+'%</td><td>'+s.in250+'%</td><td>'+s.jitter+'</td><td>'+s.monitorCorrect+'%</td><td>'+(t.dots||'')+'</td></tr>'}).join('');
  $('history').innerHTML='<div class="status" style="margin-bottom:0">Accuracy history (no-learning tests, px)</div><table><tr><th>when</th><th>mon</th><th>cams</th><th>median</th><th>mean</th><th>p90</th><th>in box</th><th>≤250</th><th>jitter</th><th>right mon</th><th>dots</th></tr>'+rows+'</table>'}catch{}}


// ---- sampling ----
function dot(cx,cy){const p=document.createElement('div');p.className='point shrink';p.style.left=cx+'px';p.style.top=cy+'px';stage.appendChild(p);return p}
async function gather(dur){const frames=[],until=performance.now()+dur;let seen=-1;
  while(performance.now()<until&&!session.stop){if(latest&&latest.id!==seen&&!latest.blink){seen=latest.id;frames.push(latest.c)}await sleep(16)}return frames}
// Drop frames whose iris position (per camera) is far from the fixation's median: glances away, landmark glitches.
function robust(frames,target,g){
  if(frames.length<6)return [];
  const N=frames.reduce((a,c)=>Math.max(a,c.length),0),lim=[];
  for(let i=0;i<N;i++){const fs=frames.filter(c=>c[i]).map(c=>c[i]);if(fs.length<4){lim.push(null);continue}
    const ax=fs.map(irisX),ay=fs.map(irisY),mx=median(ax),my=median(ay);
    lim.push({mx,my,tx:3*median(ax.map(v=>Math.abs(v-mx)))+2e-3,ty:3*median(ay.map(v=>Math.abs(v-my)))+2e-3})}
  return frames.filter(c=>c.some((f,i)=>f&&lim[i])&&c.every((f,i)=>!f||!lim[i]||(Math.abs(irisX(f)-lim[i].mx)<=lim[i].tx&&Math.abs(irisY(f)-lim[i].my)<=lim[i].ty)))
    .map(c=>({c:c.map((f,i)=>f&&lim[i]?f:null),x:target.x,y:target.y,g}));
}
async function collect(fx,fy,g,settle,dur,keep){
  for(let attempt=0;attempt<4;attempt++){
    const cx=fx*innerWidth,cy=fy*innerHeight,p=dot(cx,cy),target=toDesktop(cx,cy,session.rect);
    await sleep(settle);const frames=await gather(dur);
    if(session.stop){p.remove();return {rows:[]}}
    const rows=robust(frames,target,g);
    if(rows.length){if(!keep)p.remove();return {rows,p,target,cx,cy}}
    p.remove();banner.textContent='Face not found – look at the yellow dot and keep your head in view';await sleep(600);
  }
  return {rows:[]};
}
function meanPred(rows){let prev=-1;const ps=rows.map(r=>{const q=predict(model,r.c,prev);if(q)prev=q.mon;return q}).filter(Boolean);return ps.length?{x:median(ps.map(p=>p.x)),y:median(ps.map(p=>p.y))}:null}
// ---- adaptive training: a 4×3 coverage map of honest (pre-learning) error per screen region ----
// Each region keeps the errors of dots the model had NOT yet learned when they were shown: seeded from the saved
// training's leave-one-dot-out errors, then every new dot's "px off before learning". The next dot goes to the
// worst region (uncovered first), so repeated dots land where the model is weak instead of at random.
const REG_C=4,REG_R=3,REG_RECENT=4;
const regionOf=(fx,fy)=>Math.min(REG_R-1,Math.floor(fy*REG_R))*REG_C+Math.min(REG_C-1,Math.floor(fx*REG_C));
function newCoverage(key,rect){const cov={regions:Array.from({length:REG_C*REG_R},()=>({errs:[],live:0})),last:-1,el:null};
  const rows=(store.monitors[key]&&store.monitors[key].samples)||[];
  if(rows.length>=20){const k=ncamOf(rows)>=2&&rows.filter(r=>has(r.c,'01')).length>=20?'01':rows.filter(r=>has(r.c,'0')).length>=20?'0':'1';
    wantDotErr=true;dotErrs=null;try{fitVariant(rows,k)}finally{wantDotErr=false}
    for(const d of dotErrs||[]){const fx=(d.x-rect.left)/rect.width,fy=(d.y-rect.top)/rect.height;if(fx<0||fx>1||fy<0||fy>1)continue;cov.regions[regionOf(fx,fy)].errs.push(d.e)}}
  return cov}
const regEst=r=>r.errs.length?avg(r.errs.slice(-REG_RECENT)):null;
// Covered = at least 3 dots seen there and the recent pre-learning error is within the target.
const regOk=(r,target)=>r.errs.length>=3&&regEst(r)<=target;
// (Errors are offset-free: see the training loop.)
function coverageTarget(){return Number($('target').value)||200}
function nextPoint(cov){const target=coverageTarget();
  const score=(r,i)=>(regOk(r,target)?0:1e6)+(r.errs.length<3?5e5-r.errs.length*1e5:0)+(regEst(r)||0)+Math.random()*30-(i===cov.last?2e6:0);
  let best=0;cov.regions.forEach((r,i)=>{if(score(r,i)>score(cov.regions[best],best))best=i});
  // Once everything is covered keep sampling, weighted toward the worst regions.
  if(cov.regions.every(r=>regOk(r,target))){const w=cov.regions.map((r,i)=>i===cov.last?0:(regEst(r)||1)**2),t=w.reduce((a,b)=>a+b,0)*Math.random();let acc=0;for(let i=0;i<w.length;i++){acc+=w[i];if(acc>=t){best=i;break}}}
  cov.last=best;const c=best%REG_C,r=Math.floor(best/REG_C);
  return [Math.min(.97,Math.max(.03,(c+.1+.8*Math.random())/REG_C)),Math.min(.96,Math.max(.04,(r+.1+.8*Math.random())/REG_R))]}
function drawCoverage(cov){const target=coverageTarget();
  if(!cov.el){cov.el=document.createElement('div');cov.el.id='cov';cov.el.style.gridTemplateColumns='repeat('+REG_C+',1fr)';cov.el.style.gridTemplateRows='repeat('+REG_R+',1fr)';
    if(!covVisible)cov.el.classList.add('off');stage.appendChild(cov.el);for(let i=0;i<REG_C*REG_R;i++)cov.el.appendChild(document.createElement('div'))}
  cov.regions.forEach((r,i)=>{const e=regEst(r),d=cov.el.children[i],ok=regOk(r,target);
    d.style.background=e===null?'transparent':ok?'#42ff7914':e<=1.5*target?'#ffcc3718':'#ff6b6b1c';
    d.textContent=(e===null?'no data':Math.round(e)+' px')+' · '+r.errs.length+' dot'+(r.errs.length===1?'':'s')+(ok?' ✓':'')})}
let covVisible=true;
// Progress verdict for the HUD: covered regions, and whether new dots are still lowering the error.
function coverageVerdict(cov,errors){const target=coverageTarget(),ok=cov.regions.filter(r=>regOk(r,target)).length,n=cov.regions.length;
  let plateau=null;if(errors.length>=30){const a=avg(errors.slice(-15)),b=avg(errors.slice(-30,-15));if(a>=0.95*b)plateau=a}
  if(ok===n)return {done:true,text:'✓ ENOUGH DATA: all '+n+' regions predict within '+target+' px before learning – press Enter to finish (or keep going to refine)'};
  if(plateau!==null)return {done:true,text:'◼ PLATEAU: the last 15 dots were no better than the 15 before (~'+plateau+' px) – more dots here are not helping; press Enter and use Recenter / check the eye view'};
  return {done:false,text:'coverage '+ok+'/'+n+' regions within '+target+' px'}}
function inTol(p,t){const v=$('verify').value;if(v==='off')return true;if(v==='box')return Math.abs(p.x-t.x)<=46&&Math.abs(p.y-t.y)<=36;return Math.hypot(p.x-t.x,p.y-t.y)<=Number(v)}
function tolZone(cx,cy){const v=$('verify').value;if(v==='off')return null;const z=document.createElement('div');z.className='tol';const sx=innerWidth/session.rect.width,sy=innerHeight/session.rect.height;
  if(v==='box'){z.style.width=92*sx+'px';z.style.height=72*sy+'px';z.style.borderRadius='12px'}else{z.style.width=2*Number(v)*sx+'px';z.style.height=2*Number(v)*sy+'px';z.style.borderRadius='50%'}
  z.style.left=cx+'px';z.style.top=cy+'px';stage.appendChild(z);return z}
// Keep the dot up until the live estimate lands in the tolerance zone for ~6 frames (or time runs out).
// Frames seen while waiting are still labelled with the dot, so a miss turns into extra training data.
async function verify(p,target,g,cx,cy){
  if($('verify').value==='off'||!model)return {hit:null,ms:0,rows:[]};
  const limit=Number($('verifyTimeout').value)||5000,start=performance.now(),zone=tolZone(cx,cy);
  let streak=0,seen=-1,frames=[],recent=[],prev=-1;const extra=[];p.classList.add('verify');
  try{
    while(performance.now()-start<limit&&!session.stop){
      if(session.paused){await sleep(100);continue}
      if(latest&&latest.id!==seen&&!latest.blink){seen=latest.id;frames.push(latest.c);
        const q=predict(model,latest.c,prev);
        if(q){prev=q.mon;recent.push(q);if(recent.length>5)recent.shift()}
        if(recent.length>=3&&inTol({x:median(recent.map(r=>r.x)),y:median(recent.map(r=>r.y))},target)){
          if(++streak>=6){p.classList.add('hit');await sleep(160);extra.push(...robust(frames,target,g));return {hit:true,ms:performance.now()-start,rows:extra}}
        }else streak=0;
        // Still missing after ~1.5 s: fold the waiting frames into the model so the box can move toward the dot.
        if(frames.length>=45&&streak===0){const add=robust(frames.splice(0),target,g);session.samples.push(...add);model=fitAll()||model;recent=[]}
      }
      await sleep(16);
    }
    extra.push(...robust(frames,target,g));return {hit:false,ms:limit,rows:extra};
  }finally{if(zone)zone.remove()}
}
async function enterMonitor(i){
  const s=screens[i];const fs=s.obj?document.documentElement.requestFullscreen({screen:s.obj}):document.documentElement.requestFullscreen();
  try{await fs}catch(e){setStatus('Could not open fullscreen on Monitor '+(i+1)+': '+e.message+'. Drag this window to that monitor and try again.');return null}
  await sleep(450);return s.obj?s:(windowScreen()||s);
}
async function leaveMonitor(){session=null;phase='live';banner.style.display='none';hud.style.display='none';banner.style.background='';stage.querySelectorAll('.point,.tol,#map,#cov').forEach(p=>p.remove());
  if(document.fullscreenElement)await document.exitFullscreen().catch(()=>{});$('panel').classList.remove('hidden')}


// ---- training ----
const QUICK=[[.1,.1],[.5,.1],[.9,.1],[.1,.5],[.5,.5],[.9,.5],[.1,.9],[.5,.9],[.9,.9]];
async function train(i,fresh){
  if(phase==='training'||phase==='testing')return;if(savingNow){result.textContent='Still saving the last training run – try again in a moment.';return}const s=screens[i];
  const rect=await enterMonitor(i);if(!rect)return;
  {const bad=rectProblem(rect);if(bad){await leaveMonitor();result.textContent='Training not started: '+bad;logEvent('rect-rejected',{monitor:keyOf(rect),inner:[innerWidth,innerHeight],why:bad});return}}
  const key=keyOf(rect),N=screens.length,existing=(!fresh&&store.monitors[key]&&store.monitors[key].samples)||[];
  // New training is recorded in today's posture, so this monitor's old drift correction no longer applies.
  if(model&&model.bias)model.bias=model.bias.filter(b=>b.key!==key);
  const run=Date.now().toString(36);
  session={key,rect,label:s.label,index:i,samples:existing.slice(),stop:false,paused:false,run};
  phase='training';$('panel').classList.add('hidden');banner.style.display='block';hud.style.display='block';
  const title='TRAINING MONITOR '+(i+1)+' of '+N+' · '+s.label+' ('+rect.width+'×'+rect.height+') · '+cams.length+' camera'+(cams.length>1?'s':'');
  let n=0,hits=0,tried=0;const errors=[],hitMs=[];
  logEvent('train-start',{run,monitor:key,fresh:!!fresh,existingSamples:existing.length,verify:$('verify').value,target:coverageTarget()});
  fastFit=true;
  try{
    if(!existing.length){
      model=fitAll();
      for(let q=0;q<QUICK.length&&!session.stop;q++){banner.textContent=title+' · quick calibration '+(q+1)+'/'+QUICK.length+' – look at the dot';hud.textContent='Building the first model… keep your head still and follow the dots with your eyes';
        const c=await collect(QUICK[q][0],QUICK[q][1],key+'#'+run+':q'+q,650,800,false);session.samples.push(...c.rows);
        if(c.rows.length)logEvent('dot',{run,monitor:key,dot:'q'+q,target:c.target,frames:c.rows.length,camFrames:cams.map((_,k)=>c.rows.filter(r=>r.c[k]).length)})}
      model=fitAll()||model;
    }
    const cov=newCoverage(key,rect);session.cov=cov;drawCoverage(cov);let announced=false;const resid=[],shapes=[];session.shapes=shapes;
    while(!session.stop){
      if(session.paused){banner.textContent=title+' · PAUSED – press Space to resume';await sleep(150);continue}
      const [fx,fy]=nextPoint(cov),reg=cov.last;
      if(!n)banner.textContent=title+' · training – look at the dot (dots go to the weakest region; the grid shows the error per region before learning)';
      const g=key+'#'+run+':'+n,c=await collect(fx,fy,g,700,600,true);if(!c.rows.length)continue;
      let err=null,pre=null,shape=null;if(model){pre=meanPred(c.rows);if(pre){const dx=pre.x-c.target.x,dy=pre.y-c.target.y;err=Math.hypot(dx,dy);errors.push(err);
        // Region error excludes this session's constant offset (median of the last 10 dots' residuals): that part is
        // posture drift which Recenter fixes, not something more dots in a region can teach the model.
        const rec=resid.slice(-10);shape=rec.length>=5?Math.hypot(dx-median(rec.map(r=>r[0])),dy-median(rec.map(r=>r[1]))):err;resid.push([dx,dy]);shapes.push(shape);
        cov.regions[reg].errs.push(shape);cov.regions[reg].live++;drawCoverage(cov)}}
      session.samples.push(...c.rows);model=fitAll()||model;
      const v=await verify(c.p,c.target,g,c.cx,c.cy);c.p.remove();
      if(v.rows.length){session.samples.push(...v.rows);model=fitAll()||model}
      if(v.hit!==null){tried++;if(v.hit){hits++;hitMs.push(v.ms)}}
      n++;
      logEvent('dot',{run,monitor:key,dot:n,target:{x:Math.round(c.target.x),y:Math.round(c.target.y)},pred:pre&&{x:Math.round(pre.x),y:Math.round(pre.y)},preErr:err===null?null:Math.round(err),hit:v.hit,ms:Math.round(v.ms),frames:c.rows.length+v.rows.length,
        camFrames:cams.map((_,k)=>c.rows.concat(v.rows).filter(r=>r.c[k]).length),cv:model&&(model.routedCvErrorPx??model.cvErrorPx)});
      const verdict=coverageVerdict(cov,shapes);banner.textContent=title+' · '+verdict.text;banner.style.background=verdict.done?'#0d3b1e':'';
      if(verdict.done&&!announced){announced=true;logEvent('coverage',{run,monitor:key,dot:n,verdict:verdict.text,regions:cov.regions.map(r=>({est:regEst(r)&&Math.round(regEst(r)),n:r.errs.length}))})}
      const offTxt=resid.length>=5?' · session offset ('+Math.round(median(resid.slice(-10).map(r=>r[0])))+', '+Math.round(median(resid.slice(-10).map(r=>r[1])))+') px'+(median(resid.slice(-10).map(r=>r[1]))>0?' (reads low)':' (reads high)'):'';
      hud.textContent='dot '+n+(err===null?'':' · '+Math.round(err)+' px off before learning'+(shape!==null&&shape!==err?' ('+Math.round(shape)+' without the offset)':''))+offTxt+' · recent avg '+avg(errors.slice(-8))+' px (first '+avg(errors.slice(0,8))+')'
        +(tried?' · registered '+hits+'/'+tried+' ('+(v.hit?'✓ last':'✗ last')+' · '+Math.round(100*hits/tried)+'%'+(hitMs.length?', avg '+(avg(hitMs)/1000).toFixed(1)+' s':'')+')':'')+' · '+cvText(model)+(session.saveError?' · ⚠ NOT SAVED: '+session.saveError:'')+' · Space pause · Enter/Esc finish';
      if(n%8===0)save().catch(e=>console.warn('autosave failed',e));
    }
    // Return to the setup screen right away; the (large) save finishes in the background.
    const sess=session;await leaveMonitor();renderMonitors();
    result.textContent='Saving Monitor '+(i+1)+' training…';
    savingNow=true;try{await save(sess)}finally{savingNow=false}
    // Full refit (with the kernel correction layer, skipped during training for speed) from the saved store.
    fastFit=false;try{const full=fitAll();if(full){model=full;await api('/api/model',{epoch,model,cameras:camConfig()})}}catch(e){console.warn('full refit failed',e)}
    result.textContent='Saved Monitor '+(i+1)+': '+new Set(sess.samples.map(r=>r.g)).size+' dots'+(errors.length?' · pre-learning error went from ~'+avg(errors.slice(0,8))+' px to ~'+avg(errors.slice(-8))+' px':'')+(tried?' · dots registered in zone: '+hits+'/'+tried:'')+(sess.cov?' · '+coverageVerdict(sess.cov,sess.shapes||[]).text.replace(/ – press Enter.*$/,''):'')+(model&&model.fit===MODEL_FIT?' · '+cvText(model):'')+'. Now run Test accuracy for an honest number.';
    try{logEvent('train-end',{run,monitor:key,dots:n,hits,tried,regions:sess.cov&&sess.cov.regions.map(r=>({est:regEst(r)&&Math.round(regEst(r)),n:r.errs.length,live:r.live})),krr:!!(model&&Object.values(model.variants).some(v=>v.krr)),cv:model&&(model.routedCvErrorPx??model.cvErrorPx),variants:model&&model.variants&&Object.fromEntries(Object.entries(model.variants).map(([k,v])=>[k,v.cvErrorPx]))})}catch(e){console.warn('train-end log failed',e)}
  }catch(e){result.textContent='Training was NOT saved: '+e.message+(localStorage.getItem('eyePending')?' – a local copy is kept and will be uploaded when the server is back (reload this page).':'')}
  finally{fastFit=false;if(session)await leaveMonitor();renderMonitors()}
}


// ---- accuracy test (no learning) ----
const TEST_PTS=[];for(const y of [.1,.5,.9])for(const x of [.08,.36,.64,.92])TEST_PTS.push([x,y]);
async function testAccuracy(i){
  if(phase==='training'||phase==='testing'||!model)return;const s=screens[i];
  const rect=await enterMonitor(i);if(!rect)return;
  {const bad=rectProblem(rect);if(bad){await leaveMonitor();result.textContent='Test not started: '+bad;return}}
  const key=keyOf(rect),pts=[];
  session={key,rect,label:s.label,index:i,samples:[],stop:false,paused:false,test:true};
  phase='testing';$('panel').classList.add('hidden');banner.style.display='block';hud.style.display='block';
  const hideGaze=gaze.style.visibility;gaze.style.visibility='hidden';
  try{
    for(let k=0;k<TEST_PTS.length&&!session.stop;k++){
      banner.textContent='ACCURACY TEST · Monitor '+(i+1)+' · point '+(k+1)+'/'+TEST_PTS.length+' – look at the dot (nothing is learned; the gaze box is hidden so it cannot pull your eyes)';
      hud.textContent='Measuring the current model as-is · Esc to abort';
      const cx=TEST_PTS[k][0]*innerWidth,cy=TEST_PTS[k][1]*innerHeight,p=dot(cx,cy),target=toDesktop(cx,cy,rect);
      await sleep(900);const frames=await gather(1000);p.remove();if(session.stop)break;
      let prev=-1;const preds=frames.map(c=>{const q=predict(model,c,prev);if(q)prev=q.mon;return q}).filter(Boolean);
      if(preds.length<6){pts.push({target,cx,cy,miss:true});continue}
      const mx=median(preds.map(q=>q.x)),my=median(preds.map(q=>q.y));
      const jitter=Math.sqrt(preds.reduce((a,q)=>a+(q.x-mx)**2+(q.y-my)**2,0)/preds.length);
      const right=preds.filter(q=>q.mon<0?!!(screenAt(q.x,q.y)&&keyOf(screenAt(q.x,q.y))===key):model.perMonitor[q.mon].key===key).length/preds.length;
      // Also score each single camera so you can see whether the second camera helps.
      const perCam={};for(const v of Object.keys((model.perMonitor&&model.perMonitor.find(p=>p.key===key)||model).variants)){const vs=(model.perMonitor&&model.perMonitor.find(p=>p.key===key)||model).variants,ps=frames.filter(c=>has(c,v)).map(c=>applyModel(vs[v],vec(c,v)));
        if(ps.length>=6)perCam[v]=Math.round(Math.hypot(median(ps.map(q=>q.x))-target.x,median(ps.map(q=>q.y))-target.y))}
      pts.push({target,cx,cy,pred:{x:mx,y:my},err:Math.hypot(mx-target.x,my-target.y),dx:mx-target.x,dy:my-target.y,jitter,right,frames:frames.length,raw:frames,perCam,variant:median(preds.map(q=>q.v.length))>1?'01':preds[0].v});
      await sleep(150);
    }
    const ok=pts.filter(q=>!q.miss);
    if(ok.length>=4&&!session.stop){
      const errs=ok.map(q=>q.err).sort((a,b)=>a-b),pct=f=>Math.round(100*ok.filter(f).length/ok.length);
      const third=(lo,hi)=>{const v=ok.filter(q=>q.cx>=lo*innerWidth&&q.cx<hi*innerWidth).map(q=>q.err);return v.length?Math.round(median(v)):null};
      const camMed={};ok.forEach(q=>Object.entries(q.perCam).forEach(([k,v])=>{(camMed[k]=camMed[k]||[]).push(v)}));Object.keys(camMed).forEach(k=>{camMed[k]=Math.round(median(camMed[k]))});
      // Constant offset vs. shape error: the median shift, and what the error would be with that shift removed.
      const offX=median(ok.map(q=>q.dx)),offY=median(ok.map(q=>q.dy)),oldBias=biasFor(model,key);
      const summary={points:ok.length,missed:pts.length-ok.length,median:Math.round(median(errs)),mean:avg(errs),p90:Math.round(errs[Math.min(errs.length-1,Math.floor(errs.length*.9))]),
        meanDx:avg(ok.map(q=>Math.abs(q.dx))),meanDy:avg(ok.map(q=>Math.abs(q.dy))),biasX:avg(ok.map(q=>q.dx)),biasY:avg(ok.map(q=>q.dy)),
        inBox:pct(q=>Math.abs(q.dx)<=46&&Math.abs(q.dy)<=36),in150:pct(q=>q.err<=150),in250:pct(q=>q.err<=250),jitter:avg(ok.map(q=>q.jitter)),monitorCorrect:Math.round(100*ok.reduce((a,q)=>a+q.right,0)/ok.length),
        pctOfWidth:Math.round(1000*median(errs)/rect.width)/10,left:third(0,.34),center:third(.34,.67),right:third(.67,1.01),byCamera:camMed,
        offsetX:Math.round(offX),offsetY:Math.round(offY),medianWithoutOffset:Math.round(median(ok.map(q=>Math.hypot(q.dx-offX,q.dy-offY)))),driftCorrection:oldBias?[oldBias.dx,oldBias.dy]:null};
      // Error map: white = where you looked, red = what the model estimated.
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.id='map';
      svg.innerHTML=ok.map(q=>{const l=toLocal(q.pred,rect),sx=innerWidth/rect.width;return '<line x1="'+q.cx+'" y1="'+q.cy+'" x2="'+l.x+'" y2="'+l.y+'" stroke="#ff6b6b" stroke-width="2"/><circle cx="'+l.x+'" cy="'+l.y+'" r="'+Math.max(6,q.jitter*sx)+'" fill="#ff6b6b33" stroke="#ff6b6b"/><rect x="'+(q.cx-46*sx)+'" y="'+(q.cy-36*sx)+'" width="'+92*sx+'" height="'+72*sx+'" fill="none" stroke="#42ff7966" stroke-dasharray="4"/><circle cx="'+q.cx+'" cy="'+q.cy+'" r="7" fill="#fff"/><text x="'+(q.cx+12)+'" y="'+(q.cy-10)+'" fill="#fff" font-size="13">'+Math.round(q.err)+' px</text>'}).join('');
      stage.appendChild(svg);
      const line='Monitor '+(i+1)+' accuracy: median '+summary.median+' px ('+summary.pctOfWidth+'% of width) · mean '+summary.mean+' · p90 '+summary.p90+' · left/centre/right '+summary.left+'/'+summary.center+'/'+summary.right+' · offset ('+summary.offsetX+', '+summary.offsetY+') → '+summary.medianWithoutOffset+' px median without it · ≤250px '+summary.in250+'% · jitter '+summary.jitter+' px · right monitor '+summary.monitorCorrect+'%'
        +(Object.keys(camMed).length>1?' · by camera '+Object.entries(camMed).map(([k,v])=>variantName(k)+' '+v).join(', '):'');
      banner.textContent='Test done – white dot = target, red = estimate, circle = jitter. Press A to apply the measured offset as drift correction, any other key to return.';hud.textContent=line;result.textContent=line;
      const dots=Object.values(store.monitors).reduce((a,m)=>a+new Set(m.samples.map(x=>x.g)).size,0);
      const entry={time:Date.now(),monitorIndex:i,monitor:key,label:s.label,summary,dots,cameras:camConfig(),camStats:camStats(),cv:model.routedCvErrorPx!=null?model.routedCvErrorPx:model.cvErrorPx,routed:!!model.perMonitor,verify:$('verify').value,
        points:ok.map(q=>({tx:Math.round(q.target.x),ty:Math.round(q.target.y),px:Math.round(q.pred.x),py:Math.round(q.pred.y),jitter:Math.round(q.jitter),right:q.right,perCam:q.perCam,variant:q.variant}))};
      api('/api/accuracy',entry).then(loadHistory).catch(e=>{result.textContent=line+NL+'⚠ result not saved: '+e.message});
      // Raw per-camera features of every test fixation, so models can be compared offline against real test data.
      const r5=v=>Math.round(v*1e5)/1e5;
      logEvent('test-frames',{monitor:key,time:entry.time,points:ok.map(q=>({tx:Math.round(q.target.x),ty:Math.round(q.target.y),c:q.raw.map(c=>c.map(f=>f&&f.map(r5)))}))});
      session.stop=false;session.anyKey=false;session.lastKey=null;const until=performance.now()+30000;
      while(!session.anyKey&&!session.stop&&performance.now()<until)await sleep(100);
      if(session.lastKey==='a'||session.lastKey==='A'){
        const dx=(oldBias?oldBias.dx:0)-offX,dy=(oldBias?oldBias.dy:0)-offY;
        try{await setBias(key,rect,dx,dy,'test');result.textContent=line+NL+'Applied drift correction ('+Math.round(dx)+', '+Math.round(dy)+') px to Monitor '+(i+1)+'. Press Done to hand it to the desktop tracker.'}
        catch(e){result.textContent=line+NL+'⚠ drift correction not saved: '+e.message}}
    }else if(!session.stop)result.textContent='Accuracy test failed: face was not found for most points.';
  }finally{gaze.style.visibility=hideGaze;await leaveMonitor();renderMonitors()}
}
// ---- recenter: measure today's constant offset on a few dots and correct it (no retraining) ----
const RECENTER_PTS=[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8],[.5,.2],[.5,.8]];
function setBias(key,rect,dx,dy,source){const lim=v=>Math.max(-800,Math.min(800,Math.round(v)));
  const b=(model.bias||[]).filter(e=>e.key!==key);b.push({key,monitor:rectOf(rect),dx:lim(dx),dy:lim(dy),time:Date.now(),source});model.bias=b;
  logEvent('drift-correction',{monitor:key,dx:lim(dx),dy:lim(dy),source});
  return api('/api/model',{epoch,model,cameras:camConfig()})}
async function recenter(i){
  if(phase==='training'||phase==='testing'||!model)return;const s=screens[i];
  const rect=await enterMonitor(i);if(!rect)return;
  {const bad=rectProblem(rect);if(bad){await leaveMonitor();result.textContent='Recenter not started: '+bad;return}}
  const key=keyOf(rect),raw=Object.assign({},model,{bias:null}),res=[];
  session={key,rect,label:s.label,index:i,samples:[],stop:false,paused:false,test:true};
  phase='testing';$('panel').classList.add('hidden');banner.style.display='block';hud.style.display='block';
  const hideGaze=gaze.style.visibility;gaze.style.visibility='hidden';
  try{
    for(let k=0;k<RECENTER_PTS.length&&!session.stop;k++){
      banner.textContent='RECENTER · Monitor '+(i+1)+' · '+(k+1)+'/'+RECENTER_PTS.length+' – look at the dot';
      hud.textContent='Measuring today’s offset (posture, seat height) · nothing is retrained · Esc to abort';
      const cx=RECENTER_PTS[k][0]*innerWidth,cy=RECENTER_PTS[k][1]*innerHeight,p=dot(cx,cy),target=toDesktop(cx,cy,rect);
      await sleep(850);const frames=await gather(900);p.remove();if(session.stop)break;
      let prev=-1;const ps=frames.map(c=>{const q=predict(raw,c,prev);if(q)prev=q.mon;return q}).filter(q=>q&&(q.mon<0||raw.perMonitor[q.mon].key===key));
      if(ps.length>=6)res.push({dx:target.x-median(ps.map(q=>q.x)),dy:target.y-median(ps.map(q=>q.y))});
      await sleep(120);
    }
    if(res.length>=4){
      const dx=median(res.map(r=>r.dx)),dy=median(res.map(r=>r.dy)),spread=Math.round(median(res.map(r=>Math.hypot(r.dx-dx,r.dy-dy))));
      await setBias(key,rect,dx,dy,'recenter');
      result.textContent='Monitor '+(i+1)+' recentered: drift correction ('+Math.round(dx)+', '+Math.round(dy)+') px from '+res.length+' dots (remaining per-dot error ≈ '+spread+' px). Press Done to hand it to the desktop tracker.';
    }else if(!session.stop)result.textContent='Recenter failed: your gaze was not routed to Monitor '+(i+1)+' (or the face was lost) on most dots. Nothing changed.';
    else result.textContent='Recenter aborted. Nothing changed.';
  }catch(e){result.textContent='Recenter could not be saved: '+e.message}
  finally{gaze.style.visibility=hideGaze;await leaveMonitor();renderMonitors()}
}
document.addEventListener('keydown',e=>{
  if(!session){if(e.key==='d'||e.key==='D')toggleDiag();return}
  session.anyKey=true;session.lastKey=e.key;
  if(e.key==='d'||e.key==='D')toggleDiag();
  else if((e.key==='h'||e.key==='H')&&session.cov){covVisible=!covVisible;if(session.cov.el)session.cov.el.classList.toggle('off',!covVisible)}
  else if(e.code==='Space'){e.preventDefault();session.paused=!session.paused}else if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();session.stop=true}});
document.addEventListener('fullscreenchange',()=>{if(session&&!document.fullscreenElement)session.stop=true});



// ---- eye view diagnostics: what each camera actually sees ----
const eyesCanvas=$('eyes'),ectx=eyesCanvas.getContext('2d',{willReadFrequently:true}),diagText=$('diagText');
let diagOn=true,lastDiag=0;
function toggleDiag(){diagOn=!diagOn;$('diag').classList.toggle('hidden',!diagOn);$('diagToggle').textContent=(diagOn?'Hide':'Show')+' eye view (D)'}
function drawEye(video,l,a,b,top,bot,iris,ring,dx,dy,vw,vh){
  const W=184,H=123,ax=l[a].x*vw,ay=l[a].y*vh,bx=l[b].x*vw,by=l[b].y*vh,ew=Math.hypot(bx-ax,by-ay),sw=ew*1.9,sh=sw*H/W,cx=(ax+bx)/2,cy=(ay+by)/2,sx=cx-sw/2,sy=cy-sh/2,k=W/sw;
  ectx.imageSmoothingEnabled=false;ectx.drawImage(video,sx,sy,sw,sh,dx,dy,W,H);
  const P=i=>[dx+(l[i].x*vw-sx)*k,dy+(l[i].y*vh-sy)*k];
  let lum=0;try{const d=ectx.getImageData(dx+W*.25,dy+H*.3,W*.5,H*.4).data;for(let i=0;i<d.length;i+=4)lum+=.299*d[i]+.587*d[i+1]+.114*d[i+2];lum/=d.length/4}catch{}
  ectx.fillStyle='#ffcc37';for(const i of [a,b])ectx.fillRect(P(i)[0]-2,P(i)[1]-2,4,4);
  ectx.fillStyle='#5ab0ff';for(const i of [top,bot])ectx.fillRect(P(i)[0]-2,P(i)[1]-2,4,4);
  const c=P(iris),rr=ring.reduce((s,i)=>s+Math.hypot(P(i)[0]-c[0],P(i)[1]-c[1]),0)/ring.length;
  ectx.strokeStyle='#42ff79';ectx.lineWidth=1.5;ectx.beginPath();ectx.arc(c[0],c[1],rr,0,Math.PI*2);ectx.stroke();
  ectx.fillStyle='#ff4d6d';ectx.fillRect(c[0]-2,c[1]-2,4,4);
  return {eyePx:ew,irisPx:2*rr/k,lum};
}
// Per-camera quality stats; also attached to every logged dot and accuracy test.
function updateCamStat(cam,idx){
  const l=cam.lm,f=cam.f,vw=cam.video.videoWidth,vh=cam.video.videoHeight,dy=idx*123,st=cam.stat;
  ectx.fillStyle='#000';ectx.fillRect(0,dy,368,123);
  st.label=cam.label;st.width=vw;st.height=vh;st.fps=cam.fps;st.face=!!f;
  if(!l||!f){ectx.fillStyle='#ff6b6b';ectx.font='14px system-ui';ectx.fillText((idx?'B':'A')+': no face found',120,dy+66);return}
  // Image left = your right eye (camera is not mirrored here).
  const r=drawEye(cam.video,l,33,133,159,145,468,[469,470,471,472],0,dy,vw,vh),e=drawEye(cam.video,l,362,263,386,374,473,[474,475,476,477],184,dy,vw,vh);
  ectx.fillStyle='#fff';ectx.font='bold 13px system-ui';ectx.fillText(idx?'B':'A',6,dy+16);
  st.eyePx=(r.eyePx+e.eyePx)/2;st.irisPx=(r.irisPx+e.irisPx)/2;st.lum=(r.lum+e.lum)/2;st.yaw=f[8];st.noseX=f[6];
  if(!cam.blink){cam.irisBuf.push([irisX(f)*st.eyePx,irisY(f)*st.eyePx]);if(cam.irisBuf.length>30)cam.irisBuf.shift()}
  const sd=i=>{const v=cam.irisBuf.map(p=>p[i]),m=v.reduce((a,b)=>a+b,0)/(v.length||1);return Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/(v.length||1))};
  st.jitterX=sd(0);st.jitterY=sd(1);st.faceWidthPx=f[12]*vw;
}
function camStats(){return cams.map(c=>{const s=c.stat,r=v=>v===undefined?undefined:Math.round(v*100)/100;return {label:s.label,width:s.width,height:s.height,fps:s.fps,face:s.face,eyePx:r(s.eyePx),irisPx:r(s.irisPx),lum:r(s.lum),jitterX:r(s.jitterX),jitterY:r(s.jitterY),yaw:r(s.yaw),noseX:r(s.noseX),faceWidthPx:r(s.faceWidthPx)}})}
function renderDiagText(){
  if(!diagOn||performance.now()-lastDiag<250)return;lastDiag=performance.now();
  const grade=(v,good,ok)=>v>=good?'good':v>=ok?'fair':'POOR',lines=[];
  let vs=model&&model.variants;if(model&&model.perMonitor&&liveMon>=0)vs=model.perMonitor[liveMon].variants;
  cams.forEach((cam,i)=>{const s=cam.stat,n=i?'B':'A';
    lines.push(n+': '+(cam.label||'camera').slice(0,28)+' '+s.width+'×'+s.height+' @ '+s.fps+' fps');
    if(!s.face){lines.push('   no face');return}
    // Screen pixels per camera pixel of iris motion, from this camera's single-camera model.
    const m=vs&&vs[String(i)],kx=m?Math.abs(m.wx[1]/m.std[0]+m.wx[3]/m.std[2])/s.eyePx:0,ky=m?Math.abs(m.wy[2]/m.std[1]+m.wy[4]/m.std[3])/s.eyePx:0;
    const jit=Math.max(s.jitterX,s.jitterY);
    lines.push('   eye '+s.eyePx.toFixed(0)+' px ['+grade(s.eyePx,50,35)+'] · iris Ø '+s.irisPx.toFixed(1)+' · bright '+s.lum.toFixed(0)+(s.lum<50?' [TOO DARK]':s.lum>215?' [washed out]':'')+' · yaw '+s.yaw.toFixed(2));
    lines.push('   iris jitter '+s.jitterX.toFixed(2)+'/'+s.jitterY.toFixed(2)+' cam px ['+(jit<.25?'good':jit<.5?'fair':'POOR')+']'+(m?' · 1 cam px ≈ '+Math.round(kx)+'×'+Math.round(ky)+' screen px':''))});
  if(latest&&latest.v)lines.push('using '+variantName(latest.v)+(model&&model.perMonitor&&liveMon>=0?' → monitor '+(screens.findIndex(s=>keyOf(s)===model.perMonitor[liveMon].key)+1):''));
  diagText.textContent=lines.join(NL);
}

// ---- live loop ----
function renderGaze(){
  if(!smoothed){gaze.style.display='none';return}
  const l=toLocal(smoothed),inside=l.x>=0&&l.x<=innerWidth&&l.y>=0&&l.y<=innerHeight;
  gaze.style.display='flex';gaze.style.left=Math.min(innerWidth-46,Math.max(46,l.x))+'px';gaze.style.top=Math.min(innerHeight-36,Math.max(36,l.y))+'px';
  const other=screenAt(smoothed.x,smoothed.y);gaze.textContent=inside?'':(other?'→ Monitor '+(other.index+1):'off screen');
}
// Each camera runs its own FaceLandmarker. A combined frame is emitted whenever the first live camera
// produces a frame; other cameras contribute their latest result if it is fresh (< 150 ms).
function processCam(cam,idx){
  const v=cam.video;if(!cam.landmarker||v.readyState<2||v.currentTime===cam.lastTime)return false;
  cam.lastTime=v.currentTime;cam.fpsCount++;const now=performance.now();if(now-cam.fpsT>1000){cam.fps=cam.fpsCount;cam.fpsCount=0;cam.fpsT=now}
  const ts=Math.max(cam.lastTs+1,Math.round(now));cam.lastTs=ts;
  const out=cam.landmarker.detectForVideo(v,ts),lm=out.faceLandmarks&&out.faceLandmarks[0],f=feature(lm);
  cam.lm=lm||null;cam.f=f;cam.t=now;cam.frames=(cam.frames||0)+1;
  if(f){cam.opens.push(f[5]);if(cam.opens.length>90)cam.opens.shift();const s=[...cam.opens].sort((a,b)=>a-b);cam.blink=cam.opens.length>15&&f[5]<.6*s[s.length>>1]}else cam.blink=false;
  updateCamStat(cam,idx);return true;
}
function loop(){
  const now=performance.now();let emit=false;
  cams.forEach((cam,i)=>{const fresh=processCam(cam,i);
    // Camera A drives the frame clock; if it stalls, the next camera takes over.
    if(fresh&&!emit&&cams.slice(0,i).every(c=>now-(c.t||0)>200))emit=true});
  if(emit){
    const c=cams.map(cam=>cam.f&&now-cam.t<150?cam.f:null);
    if(c.some(Boolean)){latest={id:++frameId,c,blink:cams.some(cam=>cam.f&&now-cam.t<150&&cam.blink)}}else latest=null;
    if(latest&&!latest.blink&&model){const p=predict(model,latest.c,liveMon);
      if(p){liveMon=p.mon;latest.v=p.v;const dd=smoothed?Math.hypot(p.x-smoothed.x,p.y-smoothed.y):0,a=!smoothed?1:dd>180?.5:.2;
        smoothed=smoothed?{x:smoothed.x+(p.x-smoothed.x)*a,y:smoothed.y+(p.y-smoothed.y)*a}:{x:p.x,y:p.y};renderGaze();
        // Share live gaze with other tools (not while training/testing: it only competes with saves for connections).
        if(phase!=='training'&&phase!=='testing'&&!gazePosting&&now-lastPost>100){lastPost=now;gazePosting=true;const mon=screenAt(smoothed.x,smoothed.y)||windowScreen(),cl=v=>Math.max(0,Math.min(1,v));
          fetch('/api/gaze',{method:'POST',signal:AbortSignal.timeout(1000),headers:{'content-type':'application/json'},body:JSON.stringify({x:Math.round(smoothed.x),y:Math.round(smoothed.y),normalized:{x:cl((smoothed.x-mon.left)/mon.width),y:cl((smoothed.y-mon.top)/mon.height)},confidence:1,phase,source:'page',monitor:{x:mon.left,y:mon.top,width:mon.width,height:mon.height},timestamp:Date.now()})}).catch(()=>{}).finally(()=>{gazePosting=false})}}}
    const mon=smoothed&&screenAt(smoothed.x,smoothed.y);
    metrics.textContent='face: '+cams.map((cam,i)=>(i?'B ':'A ')+(cam.f?(cam.blink?'blink':'✓'):'✗')).join(' · ')+' · gaze: '+(model?(smoothed?Math.round(smoothed.x)+', '+Math.round(smoothed.y)+(mon?' (Monitor '+(mon.index+1)+')':''):'trained'):'untrained');
  }
  renderDiagText();
  requestAnimationFrame(loop);
}



// ---- setup ----
let devices=[],files=null;
const camSig=list=>(list||[]).map(c=>c.label||'').join(' | ');
async function makeLandmarker(){const opts=delegate=>({baseOptions:{modelAssetPath:'/model/face_landmarker.task',delegate},runningMode:'VIDEO',numFaces:1,outputFaceBlendshapes:false});
  try{return await FaceLandmarker.createFromOptions(files,opts('GPU'))}catch(e){console.warn('GPU delegate unavailable; using CPU',e);return FaceLandmarker.createFromOptions(files,opts('CPU'))}}
async function openCams(){
  const ids=[$('camA').value,$('camB').value].filter((v,i,a)=>v&&v!=='none'&&a.indexOf(v)===i);
  for(const c of cams.splice(0)){c.stream&&c.stream.getTracks().forEach(t=>t.stop());c.video.srcObject=null;try{c.landmarker&&c.landmarker.close()}catch{}}
  for(let i=0;i<ids.length;i++){const video=$('cam'+i);
    const stream=await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:ids[i]},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:false});
    video.srcObject=stream;await video.play();const d=devices.find(x=>x.deviceId===ids[i]);
    cams.push({video,stream,deviceId:ids[i],label:d?d.label:'camera '+(i+1),landmarker:files?await makeLandmarker():null,lastTime:-1,lastTs:0,f:null,lm:null,t:0,opens:[],irisBuf:[],fps:0,fpsCount:0,fpsT:performance.now(),stat:{}})}
  eyesCanvas.height=123*Math.max(1,cams.length);eyesCanvas.style.height=123*Math.max(1,cams.length)+'px';
  localStorage.setItem('eyeCams',JSON.stringify(cams.map(c=>c.label)));
  const trainedWith=camSig(store.cameras);
  if(Object.keys(store.monitors).length&&trainedWith&&trainedWith!==camSig(camConfig()))result.textContent='Camera setup changed (trained with: '+trainedWith+'). Existing training will be replaced when you train – or switch back.';
  logEvent('cameras',{cameras:camConfig()});
}
async function listCameras(){
  // Ask once so device labels are visible, then release that stream.
  const tmp=await navigator.mediaDevices.getUserMedia({video:true,audio:false});tmp.getTracks().forEach(t=>t.stop());
  devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
  const fill=(sel,none)=>{sel.innerHTML='';if(none){const o=document.createElement('option');o.value='none';o.textContent='— none —';sel.appendChild(o)}
    devices.forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||('Camera '+(i+1));sel.appendChild(o)})};
  fill($('camA'),false);fill($('camB'),true);
  // Preference: cameras the saved training used, then the last choice here, then the first two external webcams.
  let want=(store.cameras||[]).map(c=>c.label);
  if(!want.length)try{want=JSON.parse(localStorage.getItem('eyeCams')||'[]')}catch{want=[]}
  if(!want.length){const ext=devices.filter(d=>!/facetime|virtual|capture|obs|desk view/i.test(d.label));want=(ext.length>=2?ext.slice(0,2):devices.slice(0,1)).map(d=>d.label)}
  const pick=label=>{const d=devices.find(x=>x.label===label);return d?d.deviceId:null};
  $('camA').value=pick(want[0])||(devices[0]&&devices[0].deviceId);$('camB').value=(want[1]&&pick(want[1])!==$('camA').value&&pick(want[1]))||'none';
  $('camA').onchange=$('camB').onchange=()=>openCams().then(renderMonitors).catch(e=>setStatus('Camera failed: '+e.message));
  navigator.mediaDevices.ondevicechange=async()=>{const before=devices.length;devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');if(devices.length!==before)setStatus('Camera list changed – reload the page to pick new cameras.')};
}
async function init(){
  try{
    $('diagToggle').onclick=toggleDiag;
    // Screens first: refitting needs them to tell real monitors from stale saved geometry.
    await loadScreens();await api('/api/tracking/stop',{}).catch(()=>{});await loadStore();await restorePending();
    await listCameras();loadHistory();
    files=await FilesetResolver.forVisionTasks('/vendor/wasm');
    await openCams();
    // Refit when the saved model is missing/outdated (e.g. the feature set changed) or still routes to stale training.
    const stale=staleKeys();
    const liveTrained=Object.keys(store.monitors).filter(k=>!stale.includes(k)).length;
    if(Object.keys(store.monitors).length&&(!model||model.fit!==MODEL_FIT||(model.perMonitor&&model.perMonitor.some(p=>stale.includes(p.key)))||(liveTrained>=2&&!model.perMonitor))){
      model=fitAll();if(model)api('/api/model',{epoch,model,cameras:camConfig()}).then(()=>{result.textContent=(result.textContent?result.textContent+NL:'')+'Refit and saved the gaze model from your training data.'}).catch(e=>console.warn('model save failed',e));
      if(stale.length)result.textContent='Ignoring stale training '+stale.join(', ')+' (matches no connected monitor) – remove it below.'}
    renderMonitors();setInterval(()=>{if(phase!=='training'&&phase!=='testing')renderMonitors()},3000);
    $('done').onclick=async()=>{
      try{
        // Persist the refit model before handing off so the native worker uses exactly what this page uses.
        if(model)await api('/api/model',{epoch,model,cameras:camConfig()});
        const out=await api('/api/tracking/start',{});
        for(const c of cams){c.stream&&c.stream.getTracks().forEach(t=>t.stop());c.video.srcObject=null;c.landmarker=null}
        smoothed=null;gaze.style.display='none';
        setStatus('Desktop tracker is running ('+(out.cameras||cams.length)+' camera(s), '+(model&&model.perMonitor?'per-monitor':'combined')+' model). You can close this window; reopen it to train or test more.');
      }catch(e){result.textContent='Desktop tracker could not start: '+e.message}};
    $('reset').onclick=async()=>{if(!confirm('Forget training for all monitors? (The old data is archived on disk, not lost.)'))return;
      try{const out=await api('/api/calibration/reset',{});epoch=out.epoch;store={version:4,monitors:{}};model=null;smoothed=null;liveMon=-1;gaze.style.display='none';localStorage.removeItem('eyePending');
        result.textContent='Training cleared'+(out.archived?' (previous data archived to '+out.archived+')':'')+'.';logEvent('reset',{archived:out.archived||null});renderMonitors()}
      catch(e){result.textContent='Could NOT clear training: '+e.message}};
    loop();
  }catch(e){console.error(e);setStatus('Setup failed: '+e.message)}
}
init();
