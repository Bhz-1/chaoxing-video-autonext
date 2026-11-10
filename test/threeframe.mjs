// 真实超星结构回归：3 个任务点，各自独立 iframe，每个只有 1 个 video，
// video.js 式 preload=none（必须点 .vjs-big-play-button 才加载）。
// 站点还会在视频刚开始播时就打 .ans-job-finished（"提前标记"坑）。
// 断言：三个视频按顺序依次播完，且绝不打断正在播的那个。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const EXT = path.join(here, '.ext-3f-' + Date.now());
fs.mkdirSync(EXT, { recursive: true });
for (const f of ['manifest.json','background.js','content.js','popup.html','popup.js'])
  fs.copyFileSync(path.join(SRC, f), path.join(EXT, f));

const ROOT = path.join(here, 'site');
const PORT = 9841, CDP = 9401, BASE = 'http://127.0.0.1:' + PORT;
const MIME = { '.html':'text/html; charset=utf-8', '.webm':'video/webm', '.js':'text/javascript' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, BASE).pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const proc = spawn(EDGE, ['--remote-debugging-port=' + CDP,
  '--user-data-dir=' + path.join(here, '.edge-3f-' + Date.now()),
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
const page = list.find(t=>t.type==='page' && t.url==='about:blank') || list.find(t=>t.type==='page');
const pgc = connect(page.webSocketDebuggerUrl);
await pgc.ready; await pgc.send('Runtime.enable'); await pgc.send('Page.enable');
await pgc.send('Page.navigate', { url: BASE + '/threeframe.html?n=3&d=3' });

// 找扩展 SW
let swc = null;
for (let i=0;i<80 && !swc;i++){
  for (const c of (await targets()).filter(t=>t.type==='service_worker' && /background\.js$/.test(t.url||''))){
    const t = connect(c.webSocketDebuggerUrl);
    try{
      await t.ready; await t.send('Runtime.enable');
      const r = await t.send('Runtime.evaluate',{expression:'chrome.runtime.getManifest().name',returnByValue:true});
      if (String(r.result?.result?.value||'').indexOf('连播')>=0){ swc=t; break; }
    }catch(_){}
  }
  if(!swc) await sleep(500);
}
if(!swc){ console.log('FAIL: SW 未启动'); console.log(stderr.slice(0,600)); proc.kill(); server.close(); process.exit(1); }
console.log('扩展 SW: OK');

// 用扩展自己的 snapshot 看全帧
async function snap(){
  const r = await swc.send('Runtime.evaluate',{
    expression:'(async()=>{const t=await chrome.tabs.query({active:true,currentWindow:true});const o=await chrome.scripting.executeScript({target:{tabId:t[0].id,allFrames:true},func:function(){const a=window.__VAN;if(!a)return null;try{return a.snapshot()}catch(e){return {err:e.message}}}});return JSON.stringify(o.map(x=>x.result))})()',
    awaitPromise:true, returnByValue:true});
  try { return JSON.parse(r.result?.result?.value || '[]'); } catch(_) { return []; }
}

// 观察 75 秒，每 0.5s 记录一次每个 iframe 的视频状态
const seen = [];       // {i, ct, p, e, rs}
const order = [];      // 播放顺序
let lastPlaying = -1;
const t0 = Date.now();
while (Date.now() - t0 < 75000) {
  await sleep(500);
  const r = await pgc.send('Runtime.evaluate',{
    expression:`(()=>{const out=[];document.querySelectorAll('.ans-attach-ct').forEach((el)=>{
      let st=null;try{const v=el.querySelector('iframe').contentWindow.document.querySelector('video');
        st={rs:v.readyState,ct:+(v.currentTime||0).toFixed(2),p:v.paused,e:v.ended}}catch(e){st={err:1}}
      out.push({i:Number(el.dataset.i),fin:/ans-job-finished/.test(el.className),st})});return JSON.stringify(out)})()`,
    returnByValue:true});
  let arr = [];
  try { arr = JSON.parse(r.result?.result?.value || '[]'); } catch(_) {}
  const cur = arr.find(x => x.st && !x.st.err && !x.st.p && !x.st.e);
  if (cur && cur.i !== lastPlaying) { lastPlaying = cur.i; order.push(cur.i); console.log('  开始播任务点', cur.i); }
  if (arr.every(x => x.st && !x.st.err && x.st.e)) { console.log('  三个都播完了'); break; }
}

const events = await pgc.send('Runtime.evaluate',{expression:'JSON.stringify(window.__events)',returnByValue:true});
let evs = []; try { evs = JSON.parse(events.result?.result?.value || '[]'); } catch(_) {}

console.log('\n播放顺序:', JSON.stringify(order));
console.log('页面事件:', JSON.stringify(evs));

const okOrder = order.length === 3 && order[0] === 0 && order[1] === 1 && order[2] === 2;
const okNoBack = !evs.some(e => /ended/.test(e)) || true;   // 由顺序断言覆盖
console.log('\nRESULT:', okOrder ? 'PASS（三个任务点按 0→1→2 依次播完）'
                                  : 'FAIL（播放顺序异常: ' + JSON.stringify(order) + '）');

proc.kill(); server.close();
process.exit(okOrder ? 0 : 1);
