'use strict';
/* 诊断（临时）：离线 demo 源 + CDP，直接驱动进度条方法，验证 DOM：显示(超1s)→完成态→隐藏。 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9365;
function getJson(p){return new Promise((res,rej)=>{const r=http.get({host:'127.0.0.1',port:PORT,path:p},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})});r.on('error',rej);r.setTimeout(2000,()=>r.destroy(new Error('t')));});}
class CDP{constructor(u){this.u=u;this.id=0;this.p=new Map();this.h=[];}async connect(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=()=>j(new Error('ws'));});this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(x){return}if(m.id&&this.p.has(m.id)){const {res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}else if(m.method){this.h.forEach(f=>{try{f(m)}catch(x){}})}};}on(f){this.h.push(f);}send(m,p={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method:m,params:p}));});}async eval(e,a){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval: '+((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text));return r.result?r.result.value:undefined;}}
(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'vpc-pbar2-'));
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
  // 1) 开始探测 100 项（不显示，等 1s 阈值）
  await c.eval(`Home._startProbe(100); true`);
  out.immediate = await c.eval(`(() => ({ barExists: !!Home._probeBar, shown: Home._probeBar && Home._probeBar.shown, visible: getComputedStyle(document.getElementById('home-probe-bar')).display !== 'none' }))()`);
  await sleep(1200); // 超过 1s
  out.after1s = await c.eval(`(() => ({ shown: Home._probeBar && Home._probeBar.shown, visible: getComputedStyle(document.getElementById('home-probe-bar')).display !== 'none', text: (document.getElementById('home-probe-bar').textContent || '').slice(0,30), count: document.getElementById('home-probe-bar').querySelector('.ss-count') ? document.getElementById('home-probe-bar').querySelector('.ss-count').textContent : '' }))()`);
  // 2) 逐个完成 → 完成态
  await c.eval(`(() => { for (let i=0;i<100;i++) Home._probeOneDone(); Home._endProbe(); return true; })()`);
  await sleep(300);
  out.doneState = await c.eval(`(() => ({ text: (document.getElementById('home-probe-bar').textContent || '').slice(0,30), doneCls: document.getElementById('home-probe-bar').classList.contains('done'), visible: getComputedStyle(document.getElementById('home-probe-bar')).display !== 'none' }))()`);
  // 3) 1.5s 后隐藏
  await sleep(1500);
  out.afterHide = await c.eval(`(() => ({ barNull: Home._probeBar === null, visible: getComputedStyle(document.getElementById('home-probe-bar')).display !== 'none' }))()`);
  console.log('\n===== 首页探测进度条（直接驱动） =====');
  console.log(JSON.stringify(out, null, 2));
  const ok = out.immediate.shown === false && out.after1s.shown === true && out.after1s.visible === true
    && out.doneState.text.includes('已完成') && out.doneState.doneCls === true
    && out.afterHide.barNull === true && out.afterHide.visible === false;
  console.log('判定：', ok ? 'PASS（开始不显示→超1s显示→完成态→1.5s隐藏）' : 'FAIL');
  clean(ok?0:1);
})().catch(e=>{console.error('diag err',e);process.exit(2)});
