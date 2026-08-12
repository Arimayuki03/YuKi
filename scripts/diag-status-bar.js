'use strict';
/* 诊断（临时）：离线 demo + CDP，验证 ①renderStatusBar spinner 稳定不重建（修卡顿）②搜索进度条 首个结果/超1s显示、完成1.5s隐藏 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9366;
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vpc-sbar-'));
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
  const out={};

  // ① renderStatusBar：spinner 稳定不重建
  out.spinnerStable = await c.eval(`(() => {
    const el = $('#home-probe-bar');
    renderStatusBar(el, { text: 'a', recv: 1, total: 10 });
    const sp1 = el.find('.ss-spinner')[0];
    renderStatusBar(el, { text: 'b', recv: 2, total: 10 });
    const sp2 = el.find('.ss-spinner')[0];
    return sp1 === sp2;
  })()`);
  out.indeterminateWorks = await c.eval(`(() => {
    const el = $('#home-probe-bar');
    renderStatusBar(el, { text: 'c', recv: 0, total: 0 }); // 无总量 → indeterminate
    return el.find('.ss-bar').hasClass('indeterminate');
  })()`);
  // 完成态
  out.doneState = await c.eval(`(() => {
    const el = $('#home-probe-bar');
    renderStatusBar(el, { text: '已完成', recv: 10, total: 10, done: true });
    return { txt: el.find('.ss-text').text(), done: el.hasClass('done'), fillWidth: el.find('.ss-fill')[0].style.width };
  })()`);

  // ② 搜索进度条显示/隐藏
  await c.eval(`(async () => {
    Search._statusShown = false; Search._statusTimer = null; Search._statusDoneTimer = null; Search._lastStatus = null;
    Search._setStatus('正在搜索…', { recv: 0, total: 50 }); // recv=0 → 不显示
    return true;
  })()`);
  out.searchImmediate = await c.eval(`getComputedStyle(document.getElementById('search-status')).display !== 'none'`);
  await sleep(1100); // 超 1s → 显示
  out.searchAfter1s = await c.eval(`(() => ({ visible: getComputedStyle(document.getElementById('search-status')).display !== 'none', text: (document.getElementById('search-status').textContent||'').slice(0,30) }))()`);
  // 首个结果更新（spinner 不重建）
  await c.eval(`Search._setStatus('正在搜索…', { recv: 5, total: 50 }); true`);
  const spBefore = await c.eval(`document.querySelector('#search-status .ss-spinner')`);
  await c.eval(`Search._setStatus('正在搜索…', { recv: 6, total: 50 }); true`);
  const spAfter = await c.eval(`document.querySelector('#search-status .ss-spinner')`);
  out.searchSpinnerStable = await c.eval(`(() => { const el = document.querySelector('#search-status'); const a = el.querySelector('.ss-spinner'); Search._setStatus('正在搜索…', { recv: 7, total: 50 }); const b = el.querySelector('.ss-spinner'); return a === b; })()`);
  out.searchCount = await c.eval(`document.querySelector('#search-status .ss-count').textContent`);
  // 完成 → 已完成 → 1.5s 隐藏
  await c.eval(`Search._setStatus('已完成', { done: true }); true`);
  await sleep(200);
  out.searchDone = await c.eval(`(() => ({ txt: (document.getElementById('search-status').textContent||'').slice(0,20), done: document.getElementById('search-status').classList.contains('done') }))()`);
  await sleep(1500);
  out.searchHidden = await c.eval(`getComputedStyle(document.getElementById('search-status')).display !== 'none'`);

  console.log('\n===== 进度条 spinner 稳定 + 搜索显示/隐藏 =====');
  console.log(JSON.stringify(out, null, 2));
  const ok = out.spinnerStable === true && out.indeterminateWorks === true && out.doneState.done === true
    && out.searchImmediate === false && out.searchAfter1s.visible === true
    && out.searchSpinnerStable === true && out.searchDone.done === true && out.searchHidden === false;
  console.log('判定：', ok ? 'PASS（spinner稳定、搜索首个结果/1s显示、完成1.5s隐藏）' : 'FAIL');
  clean(ok?0:1);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
