'use strict';
/* 诊断（临时）：离线 demo 源 + 桩 doAction，确定性验证「全部」分页器。
 * feed 返回有内容但无 total/pagecount → pagecount≥2、分页器应渲染。 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9362;
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];this.errors=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vpc-pgfx-'));
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
  // 桩 doAction：homeVideoContent 返回有内容、无 total/pagecount；homeContent 返回 demo 类
  await c.eval(`(() => {
    window.__origDoAction = window.doAction;
    window.doAction = async (action, kv, path) => {
      if (action === 'homeVideoContent') {
        const n = parseInt(kv.pg, 10) || 1;
        return { page: n, list: Array.from({length: 20}, (_, i) => ({ vod_id: 'f' + n + '-' + i, vod_name: 'Feed ' + n + '-' + i })) };
      }
      if (action === 'homeContent') return { class: [{type_id:'m',type_name:'电影'},{type_id:'s',type_name:'剧集'}], list: [] };
      return window.__origDoAction(action, kv, path);
    };
    return true;
  })()`);
  await c.eval(`Home.loadHome(1); true`);
  for(let i=0;i<30;i++){const n=await c.eval(`Home._homeList.length`);if(n>0)break;await new Promise(r=>setTimeout(r,200));}
  await new Promise(r=>setTimeout(r,800));
  const out = await c.eval(`(() => ({
    homeList: Home._homeList.length,
    pagecount: Home.pagecount,
    pagerBtns: document.querySelectorAll('#home-pager .pg-btn').length,
    mode: Home.mode, page: Home.page,
  }))()`);
  console.log(JSON.stringify(out,null,2));
  console.log('判定：pagecount>=2 且 pagerBtns>0 且 homeList=20 →', (out.homeList===20 && out.pagecount>=2 && out.pagerBtns>0) ? 'PASS' : 'FAIL');
  clean(out.homeList===20 && out.pagecount>=2 && out.pagerBtns>0 ? 0 : 1);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
