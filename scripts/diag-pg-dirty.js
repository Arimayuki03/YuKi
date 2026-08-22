'use strict';
/* 诊断（临时）：离线 demo 源 + CDP，验证改每页条数后回首页视图自动重载（T80）。 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9363;
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yuki-pgdirty-'));
  fs.writeFileSync(path.join(tmp,'settings.json'),JSON.stringify({lastConfigUrl:'',onboarded:true,pageSizeHome:20},null,2));
  const ch=spawn(ELECTRON,[ROOT,'--remote-debugging-port='+PORT,'--user-data-dir='+tmp,'--no-first-run'],{stdio:['ignore','pipe','pipe']});let appLog='';
  ch.stdout.on('data',d=>appLog+=d);ch.stderr.on('data',d=>appLog+=d);
  const clean=c=>{try{ch.kill('SIGKILL')}catch(e){}setTimeout(()=>{try{fs.rmSync(tmp,{recursive:true,force:true})}catch(e){}},800);process.exit(c)};
  process.on('SIGINT',()=>clean(130));
  let v=null;for(let i=0;i<60;i++){try{v=await getJson('/json/version');if(v)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!v){console.error('no cdp\n'+appLog.slice(-1000));clean(2);}
  let pg=null;for(let i=0;i<30;i++){try{const t=await getJson('/json/list');pg=t.find(x=>x.type==='page'&&/index\.html/.test(x.url||''))||t.find(x=>x.type==='page');if(pg)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!pg){console.error('no page\n'+appLog.slice(-1000));clean(2);}
  const c=new CDP(pg.webSocketDebuggerUrl);await c.connect();await c.send('Runtime.enable');await c.send('Page.enable');
  for(let i=0;i<40;i++){try{if(await c.eval('document.readyState')==='complete')break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  await new Promise(r=>setTimeout(r,2500));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const out={};
  // 模拟：打开分类(demo 分类 categoryContent 空，但走 loadCategory 会清脏) 或直接用 home 模式
  // 先进入「全部」(home 模式)，载入完成
  await c.eval(`Home.loadHome(1); true`);
  for(let i=0;i<20;i++){const n=await c.eval(`Home._homeList.length`);if(n>0)break;await sleep(200);}
  await sleep(500);
  // 模拟改每页条数：settingsSet + invalidatePageSizeCache（真实设置页 handler 的行为）
  await c.eval(`window.yuki.settingsSet('pageSizeHome', 36).then(() => invalidatePageSizeCache())`, true);
  out.dirtyAfterChange = await c.eval(`Home._pageSizeDirty`);
  const tokBefore = await c.eval(`Home._loadToken`);
  // 切到设置视图，再切回首页
  await c.eval(`App.showView('settings'); true`);
  await sleep(300);
  await c.eval(`App.showView('home'); true`);
  await sleep(1200);
  out.dirtyAfterBack = await c.eval(`Home._pageSizeDirty`);
  out.tokenChanged = (await c.eval(`Home._loadToken`)) !== tokBefore;
  out.pageSize = await c.eval(`pageSizeOf('pageSizeHome').then(v=>v)`, true);
  out.viewHomeActive = await c.eval(`document.getElementById('view-home').classList.contains('active')`);
  console.log('\n===== 改每页条数后回首页自动重载 =====');
  console.log(JSON.stringify(out,null,2));
  const ok = out.dirtyAfterChange === true && out.dirtyAfterBack === false && out.tokenChanged === true && out.pageSize === 36;
  console.log('判定：', ok ? 'PASS（改页数→回首页自动重载，无需手动刷新）' : 'FAIL');
  clean(ok?0:1);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
