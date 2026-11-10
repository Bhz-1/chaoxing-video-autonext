
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const PROFILE = path.join(here, '.edge-tab-' + Date.now());
const PORT = 9785, CDP = 9341;
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
// 直接打开"落在测验页"的小节
await pgc.send('Page.navigate', { url: BASE + '/section.html?sec=2.1&tab=quiz' });
let swT = null;
for (let i = 0; i < 60 && !swT; i++) {
  await sleep(500);
  swT = (await targets()).find(t => t.type === 'service_worker' && /background\.js$/.test(t.url));
  if (!swT) { try { await pgc.send('Page.reload'); } catch (_) {} }
}
if (!swT) { console.log('NO_SW'); proc.kill(); server.close(); process.exit(1); }
const swc = connect(swT.webSocketDebuggerUrl);
await swc.ready; await swc.send('Runtime.enable');
const tidR = await swc.send('Runtime.evaluate', { expression: '(async()=>{const t=await chrome.tabs.query({});return String(t[0].id)})()', awaitPromise: true, returnByValue: true });
const TABID = tidR.result?.result?.value;

async function dbg() {
  const r = await swc.send('Runtime.evaluate', {
    expression: `(async()=>{
      const out = await chrome.scripting.executeScript({
        target: { tabId: ${TABID}, allFrames: true },
        func: () => (window.__VAN ? { url: location.href, status: window.__VAN.status(), debug: window.__VAN.debug() } : { url: location.href, noapi: true })
      });
      return JSON.stringify(out.map(x => x.result), null, 1);
    })()`,
    awaitPromise: true, returnByValue: true
  });
  return r.result?.result?.value;
}

console.log('=== 打开时（应落在测验页）===');
console.log(String(await dbg() || '').slice(0, 900));
await sleep(8000);
console.log('=== 8 秒后（应已自动切回视频学习并播放）===');
console.log(String(await dbg() || '').slice(0, 900));
const call = await swc.send('Runtime.evaluate', {
  expression: `(async()=>{
    const out = await chrome.scripting.executeScript({
      target: { tabId: ${TABID}, allFrames: true },
      func: () => {
        if (!window.__VAN) return { noapi: true, url: location.href };
        const s1 = window.__VAN.status();
        const tabsInfo = window.__VAN.tabs ? window.__VAN.tabs() : null;
        // 复刻内部逻辑，逐步打印
        const trace = [];
        const T = (el) => (el.textContent || '').replace(/\s+/g, '');
        for (const el of document.querySelectorAll('a,button,li,span,div,[role="tab"]')) {
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) { continue; }
          const t = T(el);
          if (!t || t.length > 14) continue;
          let hasChildWithText = false;
          for (const ch of el.children) { if (ch.getBoundingClientRect().width > 0 && T(ch)) { hasChildWithText = true; break; } }
          trace.push({ tag: el.tagName, text: t, childText: hasChildWithText, role: el.getAttribute('role'), dataTab: el.getAttribute('data-tab'), cls: String(el.className) });
        }
        // 直接试一次"切视频标签"
        let adv = null;
        try { adv = window.__VAN.advanceTask(); } catch (e) { adv = 'ERR ' + e.message; }
        return { url: location.href, hasVideoTab: s1.hasVideoTab, videoCount: s1.videoCount, adv, tabsInfo };
      }
    });
    return JSON.stringify(out.map(x => x.result), null, 1);
  })()`,
  awaitPromise: true, returnByValue: true
});
console.log('=== 直接调用 advanceTask ===');
console.log(call.result?.result?.value);

const probe = await pgc.send('Runtime.evaluate', {
  expression: `(() => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,li,span,div,[role="tab"]')) {
      const t = (el.textContent || '').replace(/\\s+/g, '');
      if (!t || t.length > 12) continue;
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, cls: el.className, text: t, vis: r.width > 0 && r.height > 0, inner: !!el.querySelector('a,button,li,span,div') });
    }
    return JSON.stringify(out, null, 1);
  })()`,
  returnByValue: true
});
console.log('=== 标签候选 ===');
console.log(probe.result?.result?.value);

const tab = await pgc.send('Runtime.evaluate', {
  expression: `(()=>{var t=document.querySelector('#tabs span.active');return t?t.getAttribute('data-tab'):'?'})()`, returnByValue: true
});
console.log('当前激活标签:', tab.result?.result?.value);
console.log('=== 日志 ===');
console.log(pgc.logs.filter(l => /VAN|mock/.test(l)).slice(-15).join('\n'));
pgc.sock.close(); swc.sock.close(); proc.kill(); server.close(); process.exit(0);
