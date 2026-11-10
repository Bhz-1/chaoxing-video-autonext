// 最简验证：扩展加载 → snapshot 可用 → 两个视频依次播完、不抽搐
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const EXT = path.join(here, '.ext-v-' + Date.now());
fs.mkdirSync(EXT, { recursive: true });
for (const f of ['manifest.json','background.js','content.js','popup.html','popup.js'])
  fs.copyFileSync(path.join(SRC, f), path.join(EXT, f));

const ROOT = path.join(here, 'site');
const PORT = 9830, CDP = 9390, BASE = 'http://127.0.0.1:' + PORT;
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, BASE).pathname));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const proc = spawn(EDGE, ['--remote-debugging-port=' + CDP,
  '--user-data-dir=' + path.join(here, '.edge-v-' + Date.now()),
  '--no-first-run','--no-default-browser-check',
  '--load-extension=' + EXT,'--disable-extensions-except=' + EXT,
  '--headless=new','--autoplay-policy=no-user-gesture-required','about:blank'],
  { stdio: ['ignore','ignore','pipe'] });
let stderr = '';
proc.stderr.on('data', d => stderr += d);

async function targets(){ for(let i=0;i<80;i++){ await sleep(400);
  try{ return await (await fetch('http://127.0.0.1:'+CDP+'/json/list')).json(); }catch(_){} } return []; }
function connect(url){
  const sock=new WebSocket(url); let id=0; const p=new Map();
  const ready=new Promise((r,j)=>{sock.addEventListener('open',r);sock.addEventListener('error',j);});
  sock.addEventListener('message',ev=>{const m=JSON.parse(ev.data);
    if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
  const send=(method,params={})=>{const i=++id;return new Promise(r=>{p.set(i,r);
    sock.send(JSON.stringify({id:i,method,params}));});};
  return {sock,ready,send};
}

const list = await targets();
const page = list.find(t => t.type==='page' && t.url==='about:blank') || list.find(t=>t.type==='page');
const pgc = connect(page.webSocketDebuggerUrl);
await pgc.ready; await pgc.send('Runtime.enable'); await pgc.send('Page.enable');
await pgc.send('Page.navigate', { url: BASE + '/twovid3.html' });

// 找我们的扩展 SW
let swc = null;
for (let i=0;i<80 && !swc;i++){
  const l = await targets();
  for (const c of l.filter(t=>t.type==='service_worker' && /background\.js$/.test(t.url||''))){
    const t = connect(c.webSocketDebuggerUrl);
    try{
      await t.ready; await t.send('Runtime.enable');
      const r = await t.send('Runtime.evaluate',{expression:'chrome.runtime.getManifest().name',returnByValue:true});
      if (String(r.result?.result?.value||'').indexOf('连播')>=0){ swc=t; break; }
    }catch(_){}
  }
  if(!swc) await sleep(500);
}
if(!swc){ console.log('FAIL: 扩展 SW 未启动'); console.log(stderr.slice(0,800)); proc.kill(); server.close(); process.exit(1); }
console.log('扩展 SW: OK');

const tidR = await swc.send('Runtime.evaluate',{
  expression:'(async()=>{const t=await chrome.tabs.query({});return String(t[0].id)})()',
  awaitPromise:true, returnByValue:true});
const TABID = tidR.result?.result?.value;

// 等视频就绪
for(let i=0;i<30;i++){ await sleep(500);
  const c = await pgc.send('Runtime.evaluate',{expression:'!!window.__ready',returnByValue:true});
  if(c.result?.result?.value===true) break; }

async function snap(){
  const r = await swc.send('Runtime.evaluate',{
    expression:`(async()=>{ try{
      const out=await chrome.scripting.executeScript({target:{tabId:${TABID},allFrames:true},
        func:()=>{ if(!window.__VAN) return {noVAN:true};
          try{ const s=window.__VAN.snapshot(); return {ok:true,vc:s.videoCount,playing:s.playing,
            next:s.nextVideoIndex,paused:s.pausedVideoIndex,xx:s.xxTasks,popup:s.popupOpen}; }
          catch(e){ return {snapErr:String(e&&e.message||e)}; } }});
      return JSON.stringify(out.map(x=>x.result));
    }catch(e){ return 'EXEC:'+String(e&&e.message||e); } })()`,
    awaitPromise:true, returnByValue:true});
  try { return JSON.parse(r.result?.result?.value||'[]'); } catch(e){ return []; }
}

console.log('快照(就绪时):', JSON.stringify(await snap()));

// 观察 25 秒，记录视频状态变化
const seen = [];
for (let i=0;i<20;i++){
  const r = await pgc.send('Runtime.evaluate',{
    expression:`JSON.stringify(Array.from(document.querySelectorAll('video')).map(v=>({
      i:v.getAttribute('data-idx'),t:+v.currentTime.toFixed(2),paused:v.paused,ended:v.ended})))`,
    returnByValue:true});
  seen.push(r.result?.result?.value);
  await sleep(1000);
}
const st = await snap();
console.log('快照(25秒后):', JSON.stringify(st));
const ev = await pgc.send('Runtime.evaluate',{expression:'JSON.stringify(window.__events)',returnByValue:true});
console.log('播放事件序列:', ev.result?.result?.value);

pgc.sock.close(); swc.sock.close(); proc.kill(); server.close(); process.exit(0);
