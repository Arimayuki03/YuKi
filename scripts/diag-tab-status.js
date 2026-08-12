'use strict';
/* 诊断（临时）：离线 demo + CDP，验证搜索页签切换不再让进度条凭空出现/常驻（T83）。 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9367;
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vpc-tabs-'));
  fs.writeFileSync(path.join(tmp,'settings.json'),JSON.stringify({lastConfigUrl:'',onboarded:true},null,2));
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
  const vis=()=>c.eval(`getComputedStyle(document.getElementById('search-status')).display !== 'none'`);
  const clickTab=stab=>c.eval(`document.querySelector('#search-tabs .class-tab[data-stab="${stab}"]').click(); true`);
  const out={};
  // 进搜索视图
  await c.eval(`document.querySelector('.main-nav-item[data-view="search"]').click(); true`);
  await sleep(400);
  // 场景A：无进行中搜索（_statusShown=false），状态栏被人为显示后，切页签应隐藏
  await c.eval(`Search._statusShown = false; $('#search-status').show(); true`);
  out.a_before = await vis();
  await clickTab('kazumi');
  await sleep(200);
  out.a_afterKazumi = await vis();
  await clickTab('aggregate');
  await sleep(200);
  out.a_afterAggregate = await vis();
  // 场景B：有进行中搜索（_statusShown=true），切聚合/kazumi 应显示，切以图搜番应隐藏
  await c.eval(`Search._statusShown = true; renderStatusBar($('#search-status'), { text: '正在搜索…', recv: 3, total: 10 }); true`);
  out.b_kazumi = await (async()=>{ await clickTab('kazumi'); await sleep(200); return vis(); })();
  out.b_image = await (async()=>{ await clickTab('image'); await sleep(200); return vis(); })();
  out.b_aggregate = await (async()=>{ await clickTab('aggregate'); await sleep(200); return vis(); })();
  // 场景C：以图搜番页签下（toggle 已隐藏状态），_setStatus(recv>0) 不应再把它显示出来
  await clickTab('image'); // 切到 image → toggle 隐藏 #search-status，_stab='image'
  await c.eval(`Search._statusShown = false; Search._setStatus('正在搜索…', { recv: 1, total: 10 }); true`);
  out.c_imageRecv = await vis();
  await c.eval(`Search._stab = 'aggregate'; true`);
  console.log('\n===== 搜索页签进度条状态 =====');
  console.log(JSON.stringify(out, null, 2));
  const ok = out.a_before === true && out.a_afterKazumi === false && out.a_afterAggregate === false
    && out.b_kazumi === true && out.b_image === false && out.b_aggregate === true
    && out.c_imageRecv === false;
  console.log('判定：', ok ? 'PASS（无搜索切页签不显示；有搜索按页签显隐；以图搜番不显示）' : 'FAIL');
  clean(ok?0:1);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
