'use strict';
/* 诊断（临时）：真实配置 + CDP，验证「全部」标签是否按设置每页条数显示影片数。
 * 设 pageSizeHome=X：①全部第 1 页(自适应首页)实际卡片数 ②第 2 页(feed)实际条数 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = Number(process.env.YUKI_CDP_PORT || 9360);
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];this.errors=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmpUserData=fs.mkdtempSync(path.join(os.tmpdir(),'yuki-allsize-'));
  const srcSettings=path.join(process.env.APPDATA||'','yuki','settings.json');
  const PS = Number(process.env.PS || 24); // 测试的每页条数
  try{const s=JSON.parse(fs.readFileSync(srcSettings,'utf8'));s.wallpaper='';s.onboarded=true;s.bangumiToken='';s.pageSizeHome=PS;delete s.listPageSize;fs.writeFileSync(path.join(tmpUserData,'settings.json'),JSON.stringify(s,null,2),'utf8');}catch(e){console.error('settings err',e.message);process.exit(2);}
  const electronArgs=[ROOT,'--remote-debugging-port='+PORT,'--user-data-dir='+tmpUserData,'--no-first-run'];
  console.log('[diag] userData =',tmpUserData,'PS=',PS);
  const child=spawn(ELECTRON,electronArgs,{stdio:['ignore','pipe','pipe']});let appLog='';
  child.stdout.on('data',d=>appLog+=d);child.stderr.on('data',d=>appLog+=d);
  const clean=c=>{try{child.kill('SIGKILL')}catch(e){}setTimeout(()=>{try{fs.rmSync(tmpUserData,{recursive:true,force:true})}catch(e){}},800);process.exit(c)};
  process.on('SIGINT',()=>clean(130));
  let v=null;for(let i=0;i<60;i++){try{v=await getJson('/json/version');if(v)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!v){console.error('CDP not ready\n'+appLog.slice(-1500));clean(2);}
  let pg=null;for(let i=0;i<30;i++){try{const t=await getJson('/json/list');pg=t.find(x=>x.type==='page'&&/index\.html/.test(x.url||''))||t.find(x=>x.type==='page');if(pg)break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  if(!pg){console.error('no page\n'+appLog.slice(-1500));clean(2);}
  const c=new CDP(pg.webSocketDebuggerUrl);await c.connect();await c.send('Runtime.enable');await c.send('Page.enable');
  c.on(m=>{if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){const t=(m.params.args||[]).map(a=>a.value!==undefined?a.value:(a.description||a.type)).join(' ');c.errors.push(String(t).slice(0,300));}if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;c.errors.push('EXC: '+(((d.exception&&d.exception.description)||d.text)+'').slice(0,300));}});
  for(let i=0;i<40;i++){try{if(await c.eval('document.readyState')==='complete')break}catch(e){}await new Promise(r=>setTimeout(r,500));}
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<90;i++){const n=await c.eval(`document.querySelectorAll('#site-select option').length`);if(n>20)break;await sleep(1000);}
  await sleep(3000);
  const out={PS};
  await c.eval(`$('#site-select').val('量子资源').trigger('change'); true`);
  for(let i=0;i<60;i++){const has=await c.eval(`[...document.querySelectorAll('#home-class .class-tab')].some(t=>t.textContent.trim()==='电影片')`);if(has)break;await sleep(500);}
  // 等全部第1页填充稳定（_homeList 达到目标或超时 30s）
  let reached = false;
  for (let i = 0; i < 60; i++) {
    const len = await c.eval(`Home._homeList.length`);
    if (len >= PS) { reached = true; break; }
    await sleep(500);
  }
  out.fillReached = reached;
  await sleep(1500); // 收尾
  out.target=await c.eval(`Home._adaptiveTarget().then(v=>v)`,true);
  out.page1HomeList=await c.eval(`Home._homeList.length`);
  out.page1Cards=await c.eval(`document.querySelectorAll('#home-grid .vod-card').length`);
  out.page1Pager=await c.eval(`document.querySelectorAll('#home-pager .pg-btn').length`);
  out.fillTid=await c.eval(`Home._fillTid`);
  out.fillPg=await c.eval(`Home._fillPg`);
  // 第 2 页（feed）
  await c.eval(`Home._fetchHomeFeed(2, ${PS}).then(()=>true)`,true);
  out.page2Feed=await c.eval(`Home._homeList.length`);
  await c.eval(`Home._fetchHomeFeed(3, ${PS}).then(()=>true)`,true);
  out.page3Feed=await c.eval(`Home._homeList.length`);
  out.errors=c.errors.slice(0,5);
  console.log('\n===== 「全部」页数与设置对比 =====');
  console.log(JSON.stringify(out,null,2));
  console.log('\n判定：page1应≈target、page2/3应=PS');
  clean(0);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
