// 场景：站点把任务点标成 ans-job-finished，但视频还在播。
// 期望：扩展等视频真播完再切小节，不能中途打断。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here=path.dirname(fileURLToPath(import.meta.url));
const SRC=path.resolve(here,'..');
const EXT=path.join(here,'.ext-md-'+Date.now());
fs.mkdirSync(EXT,{recursive:true});
for(const f of ['manifest.json','background.js','content.js','popup.html','popup.js'])
  fs.copyFileSync(path.join(SRC,f),path.join(EXT,f));
const ROOT=path.join(here,'site'); const PORT=9860, CDP=9430, BASE='http://127.0.0.1:'+PORT;
const server=http.createServer((req,res)=>{
  const f=path.join(ROOT,decodeURIComponent(new URL(req.url,BASE).pathname));
  if(!fs.existsSync(f)){res.writeHead(404);return res.end('404');}
  const ext=path.extname(f).toLowerCase();
  res.writeHead(200,{'content-type':ext==='.webm'?'video/webm':'text/html; charset=utf-8'});
  fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const proc=spawn(EDGE,['--remote-debugging-port='+CDP,'--user-data-dir='+path.join(here,'.edge-md-'+Date.now()),
  '--no-first-run','--no-default-browser-check','--load-extension='+EXT,'--disable-extensions-except='+EXT,
  '--headless=new','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
async function targets(){for(let i=0;i<80;i++){await sleep(400);try{return await (await fetch('http://127.0.0.1:'+CDP+'/json/list')).json();}catch(_){}}return[];}
function connect(url){const s=new WebSocket(url);let id=0;const p=new Map();
  const ready=new Promise((r,j)=>{s.addEventListener('open',r);s.addEventListener('error',j);});
  s.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
  const send=(me,pa={})=>{const i=++id;return new Promise(r=>{p.set(i,r);s.send(JSON.stringify({id:i,method:me,params:pa}));});};
  return {sock:s,ready,send};}
const list=await targets();
const page=list.find(t=>t.type==='page'&&t.url==='about:blank')||list.find(t=>t.type==='page');
const pgc=connect(page.webSocketDebuggerUrl);
await pgc.ready;await pgc.send('Runtime.enable');await pgc.send('Page.enable');
await pgc.send('Page.navigate',{url:BASE+'/markdone.html'});
let swc=null;
for(let i=0;i<80&&!swc;i++){const l=await targets();
  for(const c of l.filter(t=>t.type==='service_worker'&&/background\.js$/.test(t.url||''))){
    const t=connect(c.webSocketDebuggerUrl);
    try{await t.ready;await t.send('Runtime.enable');
      const r=await t.send('Runtime.evaluate',{expression:'chrome.runtime.getManifest().name',returnByValue:true});
      if(String(r.result?.result?.value||'').indexOf('连播')>=0){swc=t;break;}}catch(_){}}
  if(!swc)await sleep(500);}
if(!swc){console.log('FAIL: SW 未启动');proc.kill();server.close();process.exit(1);}
const tidR=await swc.send('Runtime.evaluate',{expression:'(async()=>{const t=await chrome.tabs.query({});return String(t[0].id)})()',awaitPromise:true,returnByValue:true});
const TABID=tidR.result?.result?.value;
for(let i=0;i<20;i++){await sleep(500);
  const c=await pgc.send('Runtime.evaluate',{expression:'!!window.__ready',returnByValue:true});
  if(c.result?.result?.value===true)break;}

// 高频 tick 20 秒，观察会不会提前切小节
let switchedEarly=false;
for(let i=0;i<40;i++){
  await swc.send('Runtime.evaluate',{expression:`(async()=>{try{return JSON.stringify(await tick(${TABID},'md'));}catch(e){return 'ERR';}})()`,awaitPromise:true,returnByValue:true});
  const s=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({
    ev:window.__events, ended:document.querySelector('video').ended,
    t:+document.querySelector('video').currentTime.toFixed(1),
    active:(document.querySelector('#catalog b.active')||{}).id})`,returnByValue:true});
  const d=JSON.parse(s.result?.result?.value||'{}');
  if((d.ev||[]).some(e=>e==='section:cur2') && !d.ended) switchedEarly=true;
  if(d.ended) break;
  await sleep(500);
}
const f=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({
  ev:window.__events, ended:document.querySelector('video').ended,
  t:+document.querySelector('video').currentTime.toFixed(1),
  d:+(document.querySelector('video').duration||0).toFixed(1),
  active:(document.querySelector('#catalog b.active')||{}).id})`,returnByValue:true});
const d=JSON.parse(f.result?.result?.value||'{}');
console.log('最终:',JSON.stringify(d));
console.log('');
console.log(!switchedEarly && d.ended?'RESULT: PASS（等视频真播完才继续，没有中途打断）'
  :'RESULT: FAIL（提前切换=' + switchedEarly + ' ended=' + d.ended + '）');
pgc.sock.close();swc.sock.close();proc.kill();server.close();process.exit(!switchedEarly&&d.ended?0:1);
