
// 断言式 E2E：验证 1) 同页视频依次播完 2) 小节顺序推进 3) 末尾停止
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
// 每次跑都把扩展复制到新目录：扩展 ID 由路径决定，换路径才能绕开 SW 缓存
const SRC_EXT = path.resolve(here, '..');
const EXT = path.join(here, '.ext-' + Date.now());
fs.mkdirSync(EXT, { recursive: true });
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(SRC_EXT, f), path.join(EXT, f));
}
const PROFILE = path.join(here, '.edge-profile-e2e');
const PORT = 9782, CDP = 9338;
const ROOT = path.join(here, 'site');
const BASE = 'http://127.0.0.1:' + PORT;

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

async function targets() {
  for (let i = 0; i < 80; i++) { await sleep(400); try { return await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json(); } catch (_) {} }
  return [];
}
function connect(url) {
  const sock = new WebSocket(url); let id = 0; const pending = new Map(); const logs = [];
  const ready = new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j); });
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  });
  const send = (method, params = {}) => { const i = ++id; return new Promise(r => { pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); }); };
  return { sock, ready, send, logs };
}

const list = await targets();
const page = list.find(t => t.type === 'page' && t.url === 'about:blank') || list.find(t => t.type === 'page');
const pgc = connect(page.webSocketDebuggerUrl);
await pgc.ready; await pgc.send('Runtime.enable'); await pgc.send('Page.enable');
await pgc.send('Page.navigate', { url: BASE + '/outer.html' });


async function pickOurSW() {
  for (let i = 0; i < 80; i++) {
    const l = await targets();
    const cands = l.filter(t => t.type === 'service_worker' && /background\.js$/.test(t.url || ''));
    for (const c of cands) {
      const tmp = connect(c.webSocketDebuggerUrl);
      try {
        await tmp.ready;
        await tmp.send('Runtime.enable');
        const r = await tmp.send('Runtime.evaluate', {
          expression: 'chrome.runtime.getManifest().name', returnByValue: true
        });
        if (String(r.result?.result?.value || '').indexOf('连播') >= 0) return tmp;
      } catch (_) {}
      try { tmp.sock.close(); } catch (_) {}
    }
    try { await pgc.send('Page.reload'); } catch (_) {}
    await sleep(500);
  }
  return null;
}

const swc = await pickOurSW();
if (!swc) { console.log('FAIL: 没找到我们的扩展 SW'); proc.kill(); server.close(); process.exit(1); }
await swc.ready; await swc.send('Runtime.enable');
const tidR = await swc.send('Runtime.evaluate', { expression: '(async()=>{const t=await chrome.tabs.query({});return String(t[0].id)})()', awaitPromise: true, returnByValue: true });
const TABID = tidR.result?.result?.value;

async function dbg() {
  const r = await swc.send('Runtime.evaluate', {
    expression: `(async()=>{
      const out = await chrome.scripting.executeScript({
        target: { tabId: ${TABID}, allFrames: true },
        func: () => {
        if (!window.__VAN) return { url: location.href, noapi: true };
        const snap = window.__VAN.snapshot();
        const vs = Array.from(document.querySelectorAll('video')).map(v => ({
          t: +v.currentTime.toFixed(2), d: +(v.duration || 0).toFixed(2),
          paused: v.paused, ended: v.ended
        }));
        return { url: location.href, snap, vs };
      }
      });
      return JSON.stringify(out.map(x => x.result));
    })()`,
    awaitPromise: true, returnByValue: true
  });
  try { return JSON.parse(r.result?.result?.value || '[]'); } catch (e) { return []; }
}
async function activeSec() {
  const r = await pgc.send('Runtime.evaluate', { expression: "(()=>{var a=document.querySelector('.posCatalog_select.active');return a?a.dataset.id:'?'})()", returnByValue: true });
  return r.result?.result?.value;
}

// 记录每秒：哪个小节 + 视频播放进度 + 是否播完
const trace = [];
const secs = [];
for (let i = 0; i < 150; i++) {
  const sec = await activeSec();
  const d = await dbg();
  const vids = d.filter(f => f && f.vs && f.vs.length).flatMap(f => f.vs);
  secs.push(sec);
  trace.push({ i, sec, vids });
  await sleep(250);
}

// 断言
const uniq = [];
for (const s of secs) if (uniq[uniq.length - 1] !== s) uniq.push(s);
console.log('小节推进顺序:', uniq.join(' -> '));

const maxT = Math.max(0, ...trace.flatMap(x => x.vids.map(v => v.t || 0)));
const finished = trace.filter(x => x.vids.some(v => v.ended)).length;
console.log('观察到的最大播放进度:', maxT.toFixed(2));
console.log('有视频播完的采样次数:', finished);

const EXPECT = ['1.2', '1.3', '2.1', '2.2', '3.1', '3.2'];
const errs = [];
if (maxT < 1.2) errs.push('视频没有真正播起来，maxT=' + maxT);
// 完整顺序：每一个小节都必须被访问，且不能跳级
const idx = EXPECT.map(x => uniq.indexOf(x));
if (idx.some(i => i < 0)) errs.push('有小节被跳过：' + EXPECT.filter((x, i) => idx[i] < 0).join(',') + ' (实际 ' + uniq.join(' -> ') + ')');
if (idx.every(i => i >= 0) && !(idx.every((v, i) => i === 0 || v > idx[i - 1]))) errs.push('小节顺序错乱: ' + uniq.join(' -> '));
if (uniq.length !== EXPECT.length) errs.push('小节数量不符，期望 ' + EXPECT.length + ' 实际 ' + uniq.length + ': ' + uniq.join(' -> '));

console.log('');
if (errs.length) { console.log('RESULT: FAIL'); errs.forEach(e => console.log(' - ' + e)); }
else console.log('RESULT: PASS');

console.log('=== VAN 日志 ===');
console.log(pgc.logs.filter(l => l.includes('[VAN]')).slice(-25).join('\n'));
console.log('=== mock 日志 ===');
console.log(pgc.logs.filter(l => l.includes('[mock')).slice(-25).join('\n'));

pgc.sock.close(); swc.sock.close(); proc.kill(); server.close();
process.exit(errs.length ? 1 : 0);
