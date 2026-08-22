'use strict';
/* 诊断（临时）：验证 invalidatePageSizeCache 会清空 Home 内容缓存（离线 demo 源，不受源限流影响）。 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9359;
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class C{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yuki-wire-'));
  fs.writeFileSync(path.join(tmp,'settings.json'),JSON.stringify({lastConfigUrl:'',onboarded:true},null,2));
  const ch=spawn(ELECTRON,[ROOT,'--remote-debugging-port='+PORT,'--user-data-dir='+tmp,'--no-first-run'],{stdio:['ignore','pipe','pipe']});
  const clean=c=>{try{ch.kill('SIGKILL')}catch(e){}setTimeout(()=>{try{fs.rmSync(tmp,{recursive:true,force:true})}catch(e){}},500);process.exit(c)};
  let v=null;for(let i=0;i<60;i++){try{v=await getJson('/json/version');if(v)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  let pg=null;for(let i=0;i<30;i++){try{const t=await getJson('/json/list');pg=t.find(x=>x.type==='page'&&/index\.html/.test(x.url||''))||t.find(x=>x.type==='page');if(pg)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!pg){console.error('no page');clean(2)}
  const c=new C(pg.webSocketDebuggerUrl);await c.connect();await c.send('Runtime.enable');
  for(let i=0;i<40;i++){try{if(await c.eval('document.readyState')==='complete')break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  await new Promise(r=>setTimeout(r,2500));
  const expr = `(async () => {
    Home._pageCache = new Map([['demo|1', { pagecount: 2, pages: new Map([[1, [] ]]) }]]);
    Home._catWin = new Map([['demo|1', { items: [], seen: new Set() }]]);
    const before = { pageCache: Home._pageCache.size, catWin: Home._catWin.size, sizeCache: Object.keys(_pageSizeCache || {}).length };
    invalidatePageSizeCache();
    const after = { pageCache: Home._pageCache ? Home._pageCache.size : -1, catWin: Home._catWin.size, sizeCache: Object.keys(_pageSizeCache || {}).length };
    return { before, after, homeHas: typeof Home.invalidatePageCaches === 'function' };
  })()`;
  const out = await c.eval(expr, true);
  console.log(JSON.stringify(out, null, 2));
  const ok = out.homeHas && out.after.pageCache === -1 && out.after.catWin === 0 && out.after.sizeCache === 0;
  console.log('接线判定:', ok ? 'PASS（invalidatePageSizeCache 清空了 Home 内容缓存 + pageSizeOf 缓存）' : 'FAIL');
  clean(ok ? 0 : 1);
})().catch(e=>{console.error(e);process.exit(2)});
