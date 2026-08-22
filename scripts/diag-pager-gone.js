'use strict';
/* 诊断（临时）：真实配置 + CDP，检查「全部」标签底部分页器。
 * 看默认源（应用自动选中第一个源）与量子资源的：feed total/pagecount、_homeList 条数、分页按钮 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9361);
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];this.errors=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yuki-pager-'));
  const src=path.join(process.env.APPDATA||'','yuki','settings.json');
  try{const s=JSON.parse(fs.readFileSync(src,'utf8'));s.wallpaper='';s.onboarded=true;s.bangumiToken='';s.pageSizeHome=20;delete s.listPageSize;fs.writeFileSync(path.join(tmp,'settings.json'),JSON.stringify(s,null,2),'utf8');}catch(e){console.error('settings',e.message);process.exit(2);}
  const ch=spawn(ELECTRON,[ROOT,'--remote-debugging-port='+PORT,'--user-data-dir='+tmp,'--no-first-run'],{stdio:['ignore','pipe','pipe']});let appLog='';
  ch.stdout.on('data',d=>appLog+=d);ch.stderr.on('data',d=>appLog+=d);
  const clean=c=>{try{ch.kill('SIGKILL')}catch(e){}setTimeout(()=>{try{fs.rmSync(tmp,{recursive:true,force:true})}catch(e){}},800);process.exit(c)};
  process.on('SIGINT',()=>clean(130));
  let v=null;for(let i=0;i<60;i++){try{v=await getJson('/json/version');if(v)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!v){console.error('CDP not ready\n'+appLog.slice(-1200));clean(2);}
  let pg=null;for(let i=0;i<30;i++){try{const t=await getJson('/json/list');pg=t.find(x=>x.type==='page'&&/index\.html/.test(x.url||''))||t.find(x=>x.type==='page');if(pg)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!pg){console.error('no page\n'+appLog.slice(-1200));clean(2);}
  const c=new CDP(pg.webSocketDebuggerUrl);await c.connect();await c.send('Runtime.enable');await c.send('Page.enable');
  c.on(m=>{if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){const t=(m.params.args||[]).map(a=>a.value!==undefined?a.value:(a.description||a.type)).join(' ');c.errors.push(String(t).slice(0,300));}if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;c.errors.push('EXC: '+(((d.exception&&d.exception.description)||d.text)+'').slice(0,300));}});
  for(let i=0;i<40;i++){try{if(await c.eval('document.readyState')==='complete')break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<120;i++){const n=await c.eval(`document.querySelectorAll('#site-select option').length`);if(n>20)break;await sleep(1000);}
  await sleep(4000);
  const out={};
  out.defaultSite=await c.eval(`document.getElementById('site-select').value`);
  const inspect=async()=>{
    for(let i=0;i<40;i++){const n=await c.eval(`Home._homeList.length`);if(n>0)break;await sleep(300);}
    await sleep(800);
    const w=await c.eval(`(() => { const win = Home._catWin.get(Home.site + '|__all__'); return win ? { total: win.total, items: win.items.length, sourcePg: win.sourcePg } : null; })()`);
    return {
      site: await c.eval(`Home.site`),
      homeList: await c.eval(`Home._homeList.length`),
      pagecount: await c.eval(`Home.pagecount`),
      pagerBtns: await c.eval(`document.querySelectorAll('#home-pager .pg-btn').length`),
      feedWin: w,
      feedTotalKnown: w ? (w.total > 0) : null,
    };
  };
  out.defaultAll=await inspect();
  // 切量子资源
  await c.eval(`$('#site-select').val('量子资源').trigger('change'); true`);
  for(let i=0;i<60;i++){const has=await c.eval(`[...document.querySelectorAll('#home-class .class-tab')].some(t=>t.textContent.trim()==='电影片')`);if(has)break;await sleep(500);}
  out.qzlAll=await inspect();
  out.errors=c.errors.slice(0,5);
  console.log('\n===== 「全部」分页器诊断 =====');
  console.log(JSON.stringify(out,null,2));
  clean(0);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
