
// 弹窗测试：超星"当前章节还有任务点未完成"提示框
// 断言：扩展必须点「下一节」，且绝不点「去学习」或隐藏模板里的按钮
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_EXT = path.resolve(here, '..');
const EXT = path.join(here, '.ext-popup-' + Date.now());
fs.mkdirSync(EXT, { recursive: true });
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) {
  fs.copyFileSync(path.join(SRC_EXT, f), path.join(EXT, f));
}
const PROFILE = path.join(here, '.edge-popup');
const PORT = 9791, CDP = 9347;
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
  '--headless=new', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

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
await pgc.send('Page.navigate', { url: BASE + '/popup.html' });


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

// 先禁止扩展自动动作，保证弹窗在观察期间不被动
await swc.send('Runtime.evaluate', {
  expression: "chrome.storage.local.set({ vanSettings: { enabled: false } })", awaitPromise: true, returnByValue: true
});
await pgc.send('Page.navigate', { url: BASE + '/popup.html?t=' + Date.now() });
await sleep(1500);

// 1) 快照里应该报告"弹窗已打开"且"有可点的下一节"
const snap = await swc.send('Runtime.evaluate', {
  expression: `(async()=>{
    const out = await chrome.scripting.executeScript({ target: { tabId: ${TABID}, allFrames: true },
      func: () => (window.__VAN && window.__VAN.snapshot ? window.__VAN.snapshot() : { noapi:true, url: location.href }) });
    return JSON.stringify(out.map(x=>x.result), null, 1);
  })()`, awaitPromise: true, returnByValue: true
});
console.log('原始快照返回:', JSON.stringify(snap).slice(0, 500));
const frames = (() => { try { return JSON.parse(snap.result?.result?.value || '[]'); } catch(e) { return []; } })();
const f0 = frames.find(f => f && f.popupOpen !== undefined && !f.noapi);
const popupFrames = frames.filter(f => f && f.popupOpen);
console.log('弹窗检测:', JSON.stringify({ popupOpen: f0 && f0.popupOpen, popupNext: f0 && f0.popupNext, 报告弹窗的帧数: popupFrames.length }));

// 2) 恢复启用，然后触发一次后台决策
await swc.send('Runtime.evaluate', {
  expression: "chrome.storage.local.set({ vanSettings: { enabled: true } })", awaitPromise: true, returnByValue: true
});
await sleep(300);
const tk = await swc.send('Runtime.evaluate', {
  expression: `(async()=>{ try { const r = await tick(${TABID}, 'popup-test'); return JSON.stringify(r); } catch(e){ return 'ERR '+e.message; } })()`,
  awaitPromise: true, returnByValue: true
});
console.log('tick 结果:', tk.result?.result?.value);
await sleep(2000);

// 3) 检查页面发生了什么
const after = await pgc.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    log: window.__mockLog || [],
    popupStillThere: !!document.querySelector('.maskDiv.jobFinishTip'),
    currentSection: (document.getElementById('cur')||{}).textContent
  })`, returnByValue: true
});
const a = JSON.parse(after.result?.result?.value || '{}');
console.log('页面事件:', JSON.stringify(a.log));
console.log('弹窗是否还在:', a.popupStillThere, '| 当前小节:', a.currentSection);

const bad = a.log.filter(x => /_BAD/.test(x));
const clickedNext = a.log.some(x => x.indexOf('POPUP_NEXT_CLICKED') >= 0);
const pass = clickedNext && bad.length === 0 && !a.popupStillThere;
console.log('');
console.log(pass ? 'RESULT: PASS（点对了「下一节」，没碰「去学习」和隐藏模板）'
                 : 'RESULT: FAIL（clickedNext=' + clickedNext + ', bad=' + JSON.stringify(bad) + '）');

pgc.sock.close(); swc.sock.close(); proc.kill(); server.close();
process.exit(pass ? 0 : 1);
