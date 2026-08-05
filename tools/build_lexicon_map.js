// skinslides 語彙ベクトルマップのデータ生成。
// 動画52・音トラック47・オノマトペ語82 を共通10軸空間へ射影し、PCAで2D配置、
// 「トラック→含む語」「語→最近傍動画」の関係を張って JSON 出力する。
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const R = f => fs.readFileSync(path.join(ROOT, f), "utf8");

const IDX = { FNAME:0, DUR:1, POS:2, DIR:3, W:4, T:5, S:6, H:7 };
let lw = JSON.parse(R("logic_weights.json"));
const AVAIL = new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,38,39,40,41,44,45,46,47,48,49,50,51,52,53,54,56]);
const numOf = f => { const m=String(f).match(/(\d+)/); return m?parseInt(m[1],10):null; };
lw = lw.filter(v => AVAIL.has(numOf(v[IDX.FNAME])));

const cv2 = JSON.parse(R("Video analysis data/metadata_cv2.json"));
const mp = JSON.parse(R("Video analysis data/metadata.json"));
const meta = JSON.parse(R("Audio analysis data/sound_metadata.json"));
let dt = R("Audio analysis data/onomatopoeia_dictionary.csv"); if(dt.charCodeAt(0)===0xFEFF) dt=dt.slice(1);

const AXES = [["x1","x1"],["x2","x2"],["x3","x3"],["x4","x4"],["x5","x5"],["x6","x6"],["x7","x7_norm"],["x8","x8"],["x9","x9_norm"],["x16","x16_regularity"]];
const AXKEYS = AXES.map(a=>a[0]);
// 辞書語ベクトル
const dictVec = {};
{ const L=dt.split(/\r?\n/).filter(x=>x.trim()); const H=L[0].split(",");
  L.slice(1).forEach(l=>{ const c=l.split(","); const r={}; H.forEach((h,i)=>r[h]=c[i]);
    const v={}; let ok=true; for(const[ax,col]of AXES){const x=parseFloat(r[col]); if(!Number.isFinite(x)){ok=false;break;} v[ax]=x;} if(ok) dictVec[r.word]=v; }); }

// 動画ベクトル（logic.js videoToVec v3 と一致）
const mpByNum={}; mp.forEach(v=>mpByNum[numOf(v.id)]=v);
const cv2ByNum={}; cv2.forEach(v=>cv2ByNum[numOf(v.id)]=v);
const px=R("pauseTime.xml"); const freezeByNum={};
for(const m of px.matchAll(/<s(\d+)\.mov>([\s\S]*?)<\/s\1\.mov>/gi)){ const n=parseInt(m[1],10); const a=(m[2].match(/<PAUSE>/gi)||[]).length; if(a)freezeByNum[n]=a; }
const durOf=n=>(cv2ByNum[n]||{}).duration_seconds||1;
const rows=lw.map(v=>numOf(v[IDX.FNAME])).filter(n=>cv2ByNum[n]);
const bounds=fn=>{const a=rows.map(fn).sort((x,y)=>x-y);const pc=p=>{const i=(a.length-1)*p/100,lo=Math.floor(i),hi=Math.ceil(i);return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(i-lo);};return[pc(10),pc(90)];};
const B={vel:bounds(n=>cv2ByNum[n].avg_body_velocity_px),con:bounds(n=>cv2ByNum[n].avg_contact_area_px),limb:bounds(n=>cv2ByNum[n].avg_limb_islands),limbM:bounds(n=>cv2ByNum[n].max_limb_islands),ext:bounds(n=>(mpByNum[n]||{}).avg_extension||0),pch:bounds(n=>{const m=mpByNum[n];return m?(m.posture_changes||[]).length/durOf(n)*60:0;}),com:bounds(n=>(mpByNum[n]||{}).com_movement||0),frz:bounds(n=>(freezeByNum[n]||0)/durOf(n)*60),int:bounds(n=>(mpByNum[n]||{}).max_intensity||0)};
const rel=(v,[lo,hi])=>hi<=lo?0:Math.max(0,Math.min(1,(v-lo)/(hi-lo)));const cl=v=>Math.max(0,Math.min(9,v));
const videoVec={};
lw.forEach(v=>{const n=numOf(v[IDX.FNAME]);const cv=cv2ByNum[n];if(!cv)return;const m=mpByNum[n]||{};
  const vr=rel(cv.avg_body_velocity_px,B.vel),cr=rel(cv.avg_contact_area_px,B.con),lr=rel(cv.avg_limb_islands,B.limb),lM=rel(cv.max_limb_islands,B.limbM),er=rel(m.avg_extension||0,B.ext),pr=rel((m.posture_changes||[]).length/durOf(n)*60,B.pch),cm=rel(m.com_movement||0,B.com),fr=rel((freezeByNum[n]||0)/durOf(n)*60,B.frz),ir=rel(m.max_intensity||0,B.int);
  const W=v[IDX.W]||0,T=v[IDX.T]||0,S=v[IDX.S]||0,H=v[IDX.H]||0;
  videoVec[n]={x1:cl(.6*W+.4*(1-vr)*9),x2:cl(.5*T+.5*vr*9),x3:cl(.4*S+.4*er*9+.2*lr*9),x4:cl(((1-fr)*.5+cm*.5)*9),x5:cl(.5*H+.5*ir*9),x6:cl(cr*9),x7:4.5,x8:cl((fr*.6+ir*.4)*9),x9:cl((pr*.6+lM*.4)*9),x16:cl(pr*9)};});

// トラックベクトル = 含むイベント語ベクトルの平均。語の頻度も集計。
const trackWords={}; const wordCount={};
meta.forEach(t=>{ const wc={}; (t.triggers.events||[]).forEach(e=>{ if(e.onomatopoeia && dictVec[e.onomatopoeia]){ wc[e.onomatopoeia]=(wc[e.onomatopoeia]||0)+1; wordCount[e.onomatopoeia]=(wordCount[e.onomatopoeia]||0)+1; } }); if(Object.keys(wc).length) trackWords[t.file_id]=wc; });
const trackVec={};
Object.entries(trackWords).forEach(([tid,wc])=>{ const v={}; AXKEYS.forEach(a=>v[a]=0); let tot=0;
  Object.entries(wc).forEach(([w,c])=>{ tot+=c; AXKEYS.forEach(a=>v[a]+=dictVec[w][a]*c); }); AXKEYS.forEach(a=>v[a]/=tot); trackVec[tid]=v; });

// 全ノード
const nodes=[];
Object.entries(videoVec).forEach(([n,v])=>nodes.push({id:"v"+n,type:"video",label:n+".mp4",vec:v,weight:1}));
Object.keys(trackWords).forEach(tid=>{ if(trackVec[tid]){ const cnt=Object.values(trackWords[tid]).reduce((a,b)=>a+b,0); nodes.push({id:"t"+tid,type:"track",label:tid.replace(/\.(aif|aiff|mp3)$/i,""),vec:trackVec[tid],weight:cnt}); } });
Object.keys(wordCount).forEach(w=>nodes.push({id:"w"+w,type:"word",label:w,vec:dictVec[w],weight:wordCount[w]}));

// PCA 2D（共分散のべき乗反復で上位2固有ベクトル）
const M=nodes.map(nd=>AXKEYS.map(a=>nd.vec[a]));
const dim=AXKEYS.length, N=M.length;
const mean=Array(dim).fill(0); M.forEach(r=>r.forEach((x,j)=>mean[j]+=x/N));
const C=M.map(r=>r.map((x,j)=>x-mean[j]));
const cov=Array.from({length:dim},()=>Array(dim).fill(0));
C.forEach(r=>{for(let i=0;i<dim;i++)for(let j=0;j<dim;j++)cov[i][j]+=r[i]*r[j]/N;});
function powerIter(A,exclude){ let v=Array(dim).fill(0).map(()=>Math.random()); 
  for(let it=0;it<200;it++){ let w=Array(dim).fill(0); for(let i=0;i<dim;i++)for(let j=0;j<dim;j++)w[i]+=A[i][j]*v[j];
    if(exclude){ const d=exclude.reduce((s,x,k)=>s+x*w[k],0); for(let i=0;i<dim;i++)w[i]-=d*exclude[i]; }
    const nrm=Math.sqrt(w.reduce((s,x)=>s+x*x,0))||1; v=w.map(x=>x/nrm); } return v; }
const pc1=powerIter(cov); const pc2=powerIter(cov,pc1);
const proj=C.map(r=>[r.reduce((s,x,j)=>s+x*pc1[j],0), r.reduce((s,x,j)=>s+x*pc2[j],0)]);
// 0..1 正規化
const xs=proj.map(p=>p[0]),ys=proj.map(p=>p[1]);
const nx=[Math.min(...xs),Math.max(...xs)],ny=[Math.min(...ys),Math.max(...ys)];
// vec(10軸の質感ベクトル)は映像選択(語→映像の距離)で使うため残す。表示だけだった頃は
// 捨てていたが、test-level2 / Play B のオノマトペ駆動に必要。小数2桁に丸めて保持する。
// dictVec/videoVec を破壊しないよう、丸めたコピーを新しく作って差し替える(この後のエッジ計算が元の値を使う)。
nodes.forEach((nd,i)=>{ nd.x=(proj[i][0]-nx[0])/(nx[1]-nx[0]); nd.y=(proj[i][1]-ny[0])/(ny[1]-ny[0]);
  const rv={}; AXKEYS.forEach(a=>rv[a]=+nd.vec[a].toFixed(2)); nd.vec=rv; });

// エッジ
const wdistVid=(a,b)=>{let s=0;for(const k of AXKEYS){if(k==="x7")continue;const d=a[k]-b[k];s+=d*d;}return Math.sqrt(s);};
const edges=[];
// track -> 含む語（頻度上位3）
Object.entries(trackWords).forEach(([tid,wc])=>{ Object.entries(wc).sort((a,b)=>b[1]-a[1]).slice(0,3).forEach(([w,c])=>edges.push({s:"t"+tid,t:"w"+w,kind:"contains",wgt:c})); });
// video -> 最近傍語1本
Object.entries(videoVec).forEach(([n,vv])=>{ let best=null,bd=1e9; Object.keys(wordCount).forEach(w=>{const d=wdistVid(vv,dictVec[w]);if(d<bd){bd=d;best=w;}}); if(best) edges.push({s:"v"+n,t:"w"+best,kind:"nearest",wgt:1,dist:+bd.toFixed(2)}); });
// 孤立語の救済: どのトラックの上位3にも入らず最近傍でもない語を、最も多く出現するトラックへ1本つなぐ
{ const linked=new Set(); edges.forEach(e=>{linked.add(e.s);linked.add(e.t);});
  Object.keys(wordCount).forEach(w=>{ if(linked.has("w"+w))return;
    let bt=null,bc=0; Object.entries(trackWords).forEach(([tid,wc])=>{ if((wc[w]||0)>bc){bc=wc[w];bt=tid;} });
    if(bt) edges.push({s:"t"+bt,t:"w"+w,kind:"contains",wgt:bc}); }); }

const out={ meta:{videos:Object.keys(videoVec).length,tracks:Object.keys(trackVec).length,words:Object.keys(wordCount).length,generated:new Date().toISOString().slice(0,10)}, nodes, edges };
fs.writeFileSync(path.join(__dirname,"lexicon_map_data.json"), JSON.stringify(out));
console.log("nodes:",nodes.length,"(video",out.meta.videos,"track",out.meta.tracks,"word",out.meta.words,") edges:",edges.length);
console.log("PC1軸の寄与が大きい元軸:", pc1.map((x,i)=>[AXKEYS[i],+x.toFixed(2)]).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,3).map(a=>a[0]+"("+a[1]+")").join(" "));
