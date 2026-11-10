
// 目录测试：5.3 的下一项是"6 专题六"标题行，扩展必须跳过它去点 6.1
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_EXT = path.resolve(here, '..');
const EXT = path.join(here, '.ext-cat-' + Date.now());
fs.mkdirSync(EXT, { recursive: true });
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(SRC_EXT, f), path.join(EXT, f));
}
const PROFILE = path.join(here, '.edge-cat-' + Date.now());
const PORT = 9793, CDP = 9349;
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
  '--no-first-run', '--no-default-browser-check',
  '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
  '--headless=new', 'about:blank'], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 80; i++) { await sleep(400); try { return await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json(); } catch (_) {} }
  return [];
}
function connect(url) {
  const sock = new WebSocket(url);
  let id = 0; const pending = new Map(); const logs = [];
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
await pgc.send('Page.navigate', { url: BASE + '/catalog.html' });


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
await sleep(2000);

// 先看扩展认为"下一节"是谁
const snap = await swc.send('Runtime.evaluate', {
  expression: `(async()=>{
    const out = await chrome.scripting.executeScript({ target: { tabId: ${TABID}, allFrames: true },
      func: () => (window.__VAN && window.__VAN.snapshot ? window.__VAN.snapshot() : {noapi:true}) });
    return JSON.stringify(out.map(x=>x.result).filter(r=>r && r.canNextSection !== undefined));
  })()`, awaitPromise: true, returnByValue: true
});
const raw = snap.result?.result?.value;
console.log('原始:', String(raw).slice(0,300));
const frames = (()=>{ try { return JSON.parse(raw || '[]'); } catch(e){ return []; } })();
const f0 = frames[0] || {};
console.log('扩展认为下一节:', JSON.stringify({ label: f0.nextSectionLabel, canNextSection: f0.canNextSection }));

// 触发决策
const tk = await swc.send('Runtime.evaluate', {
  expression: `(async()=>{ try { return JSON.stringify(await tick(${TABID}, 'cat-test')); } catch(e){ return 'ERR '+e.message; } })()`,
  awaitPromise: true, returnByValue: true
});
console.log('tick:', tk.result?.result?.value);
await sleep(1200);

const after = await pgc.send('Runtime.evaluate', {
  expression: `JSON.stringify({ events: window.__events || [], cur: (document.getElementById('cur')||{}).textContent })`,
  returnByValue: true
});
const a = JSON.parse(after.result?.result?.value || '{}');
console.log('页面事件:', JSON.stringify(a.events), '| 当前:', a.cur);

const headerClicked = a.events.some(e => e.indexOf('HEADER_CLICKED_BAD') >= 0);
const wentTo61 = a.events.some(e => e.indexOf('leaf:cur61') >= 0);
const pass = !headerClicked && wentTo61;
console.log('');
console.log(pass ? 'RESULT: PASS（跳过了专题标题，直接进 6.1）'
                 : 'RESULT: FAIL（headerClicked=' + headerClicked + ', wentTo61=' + wentTo61 + '）');
pgc.sock.close(); swc.sock.close(); proc.kill(); server.close();
process.exit(pass ? 0 : 1);
