
// 关键合规测试：视频只看了 20% 就结束 -> 扩展必须"补看"而不是直接跳下一节
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_EXT = path.resolve(here, '..');
const EXT = path.join(here, '.ext-cov-' + Date.now());
fs.mkdirSync(EXT, { recursive: true });
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(SRC_EXT, f), path.join(EXT, f));
}
const PROFILE = path.join(here, '.edge-cov-' + Date.now());
const PORT = 9789, CDP = 9345;
const ROOT = path.join(here, 'site-cov');
const BASE = 'http://127.0.0.1:' + PORT;

// 3 秒视频，但会自动跳到 2.8s 结束（只看了 0.2s = 7%），模拟"跳着看完"
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(path.join(ROOT, 'video.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="log"></div>
<script>
var q = new URLSearchParams(location.search);
var n = Number(q.get('n') || 1);
var logEl = document.getElementById('log');
function say(s){ logEl.innerHTML += s + '<br>'; console.log('[mock-video] ' + s); }
function makeClip(seconds){
  return new Promise(function(resolve){
    var c=document.createElement('canvas');c.width=320;c.height=180;
    var ctx=c.getContext('2d');var stream=c.captureStream(20);
    var rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
    var chunks=[];rec.ondataavailable=function(e){if(e.data.size)chunks.push(e.data)};
    var done=new Promise(function(r){rec.onstop=r});
    rec.start();var t0=performance.now();
    new Promise(function(res){function draw(){var t=(performance.now()-t0)/1000;
      ctx.fillStyle='hsl('+((t*120)%360)+',60%,45%)';ctx.fillRect(0,0,320,180);
      ctx.fillStyle='#fff';ctx.font='20px sans-serif';ctx.fillText('t='+t.toFixed(2),20,100);
      if(t<seconds)requestAnimationFrame(draw);else res();}draw();}).then(function(){
      rec.stop();done.then(function(){resolve(URL.createObjectURL(new Blob(chunks,{type:'video/webm'})));});});
  });
}
makeClip(3).then(function(url){
  for(var i=0;i<n;i++){
    var v=document.createElement('video');v.src=url;v.muted=true;v.playsInline=true;
    document.body.appendChild(v);
  }
  var v0=document.querySelector('video');
  v0.play().then(function(){
    say('开始播放');
    // 关键：播放 0.4 秒后直接跳到结尾，模拟"跳着看完"
    setTimeout(function(){
      say('跳到结尾（模拟跳看）');
      v0.currentTime = v0.duration - 0.1;
    }, 400);
  });
  v0.addEventListener('ended', function(){ say('视频结束'); });
});
</script></body></html>`);

fs.writeFileSync(path.join(ROOT, 'section.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="tabs"><span data-tab="video" class="active">1 视频学习</span><span data-tab="quiz">2 章节测验</span></div>
<div id="cond">任务点 完成条件：观看时长需 ≥ 总时长的 90%（未完成任务点前，当前视频不可切换）</div>
<div id="nav"><span id="prevNextFocusNext">下一节</span></div>
<iframe id="f" src="video.html?n=1"></iframe>
<script>
document.querySelectorAll('#tabs span').forEach(function(s){s.addEventListener('click',function(){console.log('[mock] 标签 '+s.getAttribute('data-tab'))})});
document.getElementById('prevNextFocusNext').addEventListener('click',function(){
  console.log('[mock] 点了下一节');
  window.parent.postMessage({type:'mockNextSection'},'*');
});
</script></body></html>`);

fs.writeFileSync(path.join(ROOT, 'outer.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="catalog"><ul class="catalog_list">
<li class="posCatalog_select active">1.1</li><li class="posCatalog_select">1.2</li><li class="posCatalog_select">1.3</li>
</ul></div>
<iframe id="sec" src="section.html"></iframe>
<script>
var clicked = 0;
window.addEventListener('message', function(e){
  if (e.data && e.data.type === 'mockNextSection') {
    clicked++;
    console.log('[mock] 收到切小节请求 #' + clicked);
    var items = Array.from(document.querySelectorAll('.posCatalog_select'));
    for (var i=0;i<items.length-1;i++) if (items[i].classList.contains('active')) { items[i+1].click(); return; }
  }
});
document.querySelectorAll('.posCatalog_select').forEach(function(li){
  li.addEventListener('click', function(){
    document.querySelectorAll('.posCatalog_select').forEach(function(x){x.classList.remove('active')});
    li.classList.add('active');
  });
});
</script></body></html>`);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const proc = spawn(EDGE, ['--remote-debugging-port=' + CDP, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
  '--headless=new', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

async function targets() { for (let i = 0; i < 80; i++) { await sleep(400); try { return await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json(); } catch (_) {} } return []; }
function connect(url) {
  const sock = new WebSocket(url); let id = 0; const pending = new Map(); const logs = [];
  const ready = new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j); });
  sock.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; } if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')); });
  const send = (method, params = {}) => { const i = ++id; return new Promise(r => { pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); }); };
  return { sock, ready, send, logs };
}
const list = await targets();
const page = list.find(t => t.type === 'page' && t.url === 'about:blank') || list.find(t => t.type === 'page');
const pgc = connect(page.webSocketDebuggerUrl);
await pgc.ready; await pgc.send('Runtime.enable'); await pgc.send('Page.enable');
await pgc.send('Page.navigate', { url: BASE + '/outer.html' });
let swT = null;
for (let i = 0; i < 60 && !swT; i++) {
  await sleep(500);
  const l = await targets();
  swT = l.find(t => t.type === 'service_worker' && /background\.js$/.test(t.url));
  if (!swT) {
    if (i % 6 === 0) console.log('等待 SW…', l.map(t => t.type).join(','));
    try { await pgc.send('Page.reload'); } catch (_) {}
  }
}
if (!swT) { console.log('NO_SW'); proc.kill(); server.close(); process.exit(1); }
const swc = connect(swT.webSocketDebuggerUrl);
await swc.ready; await swc.send('Runtime.enable');
const tidR = await swc.send('Runtime.evaluate', { expression: '(async()=>{const t=await chrome.tabs.query({});return String(t[0].id)})()', awaitPromise: true, returnByValue: true });
const TABID = tidR.result?.result?.value;

for (let i = 0; i < 24; i++) {
  const secR = await pgc.send('Runtime.evaluate', { expression: "(()=>{var a=document.querySelector('.posCatalog_select.active');return a?a.textContent:'?'})()", returnByValue: true });
  const vR = await swc.send('Runtime.evaluate', {
    expression: `(async()=>{
      const out = await chrome.scripting.executeScript({ target: { tabId: ${TABID}, allFrames: true },
        func: () => { const vs = Array.from(document.querySelectorAll('video')); return { u: location.href.split('/').pop(), v: vs.map(x=>({t:+x.currentTime.toFixed(2), d:+(x.duration||0).toFixed(2)})) }; } });
      return JSON.stringify(out.map(x=>x.result).filter(r=>r.v.length));
    })()`, awaitPromise: true, returnByValue: true
  });
  console.log('t=' + i + 's 小节=' + secR.result?.result?.value + ' 视频=' + (vR.result?.result?.value || ''));
  await sleep(1000);
}
const secR = await pgc.send('Runtime.evaluate', { expression: "(()=>{var a=document.querySelector('.posCatalog_select.active');return a?a.textContent:'?'})()", returnByValue: true });
const finalSec = secR.result?.result?.value;
const logs = pgc.logs.filter(l => /mock|VAN/.test(l));
const jumped = logs.some(l => l.includes('点了下一节'));
const replayed = logs.some(l => l.includes('补看') || l.includes('观看时长不足'));
const dbgR = await swc.send('Runtime.evaluate', {
  expression: `(async()=>{
    const out = await chrome.scripting.executeScript({ target: { tabId: ${TABID}, allFrames: true },
      func: () => (window.__VAN && window.__VAN.debug ? window.__VAN.debug() : { url: location.href, noapi: true }) });
    return JSON.stringify(out.map(x=>x.result), null, 1);
  })()`, awaitPromise: true, returnByValue: true
});
console.log('=== 覆盖率内部状态 ===');
const dbgVal = dbgR.result?.result?.value || '';
try {
  const arr = JSON.parse(dbgVal);
  for (const f of arr) {
    if (f && f.videos && f.videos.length) {
      console.log('帧:', (f.url||'').split('/').pop());
      console.log('  settings.requireCompletion =', f.settings && f.settings.requireCompletion);
      for (const v of f.videos) console.log('  视频:', JSON.stringify(v));
    }
  }
} catch (e) { console.log(String(dbgVal).slice(0, 400)); }
console.log('=== 日志 ===');
console.log(logs.slice(-12).join('\n'));
console.log('');
console.log('最终小节:', finalSec, '| 是否点了下一节:', jumped, '| 是否触发补看/拦截:', replayed);
// 按用户最新要求：不设 90% 门槛，视频播完即可切下一节
const pass = jumped;
console.log(pass ? 'RESULT: PASS（视频播完即切下一节，无 90% 门槛）' : 'RESULT: FAIL（播完却没有切）');
process.exit(pass ? 0 : 1);
pgc.sock.close(); swc.sock.close(); proc.kill(); server.close(); process.exit(0);
