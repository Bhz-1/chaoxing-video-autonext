// 卡死场景：视频播到中间被暂停，且带 vanPlayed=1 标记。
// 旧版会永久跳过它（再也播不动）；新版必须把它接手播完。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here=path.dirname(fileURLToPath(import.meta.url));
const SRC=path.resolve(here,'..');
const EXT=path.join(here,'.ext-st-'+Date.now());
fs.mkdirSync(EXT,{recursive:true});
for(const f of ['manifest.json','background.js','content.js','popup.html','popup.js'])
  fs.copyFileSync(path.join(SRC,f),path.join(EXT,f));
const ROOT=path.join(here,'site'); const PORT=9840, CDP=9400, BASE='http://127.0.0.1:'+PORT;
const server=http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(new URL(req.url,BASE).pathname));
  if(!fs.existsSync(f)){res.writeHead(404);return res.end('404');}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const proc=spawn(EDGE,['--remote-debugging-port='+CDP,'--user-data-dir='+path.join(here,'.edge-st-'+Date.now()),
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
await pgc.send('Page.navigate',{url:BASE+'/stuck.html'});
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

for(let i=0;i<30;i++){await sleep(500);
  const c=await pgc.send('Runtime.evaluate',{expression:'!!window.__ready',returnByValue:true});
  if(c.result?.result?.value===true)break;}
const before=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({ev:window.__events,
  t:+document.querySelector('video').currentTime.toFixed(2),
  paused:document.querySelector('video').paused,
  vanPlayed:document.querySelector('video').dataset.vanPlayed||''})`,returnByValue:true});
console.log('卡住时:',before.result?.result?.value);

// 等扩展接手（看门狗/心跳最多等 40 秒）
for(let i=0;i<40;i++){await sleep(1000);
  const s=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({ended:document.querySelector('video').ended,
    t:+document.querySelector('video').currentTime.toFixed(2),paused:document.querySelector('video').paused})`,returnByValue:true});
  const d=JSON.parse(s.result?.result?.value||'{}');
  if(d.ended){console.log('已播完 @' + d.t + 's');break;}
  if(i%5===0)console.log('  等待中… t='+d.t+' paused='+d.paused);}
const after=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({ev:window.__events,
  t:+document.querySelector('video').currentTime.toFixed(2),ended:document.querySelector('video').ended})`,returnByValue:true});
const a=JSON.parse(after.result?.result?.value||'{}');
console.log('最终:',after.result?.result?.value);
const pass=!!a.ended;
console.log('');
console.log(pass?'RESULT: PASS（卡住的视频被接手并播完）':'RESULT: FAIL（视频仍然卡着不动）');
pgc.sock.close();swc.sock.close();proc.kill();server.close();process.exit(pass?0:1);
