// video.js 场景：<video> 有 src 但 readyState=0，只有点 .vjs-big-play-button 才加载。
// 扩展必须能点那个按钮，否则视频永远停在 0 秒（死锁）。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here=path.dirname(fileURLToPath(import.meta.url));
const SRC=path.resolve(here,'..');
const EXT=path.join(here,'.ext-vjs-'+Date.now());
fs.mkdirSync(EXT,{recursive:true});
for(const f of ['manifest.json','background.js','content.js','popup.html','popup.js'])
  fs.copyFileSync(path.join(SRC,f),path.join(EXT,f));
const ROOT=path.join(here,'site'); const PORT=9851, CDP=9411, BASE='http://127.0.0.1:'+PORT;
const server=http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(new URL(req.url,BASE).pathname));
  if(!fs.existsSync(f)){res.writeHead(404);return res.end('404');}
  const ext = path.extname(f).toLowerCase();
  const mime = ext === '.webm' ? 'video/webm' : (ext === '.mjs' ? 'text/javascript' : 'text/html; charset=utf-8');
  res.writeHead(200,{'content-type':mime});fs.createReadStream(f).pipe(res);});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
const proc=spawn(EDGE,['--remote-debugging-port='+CDP,'--user-data-dir='+path.join(here,'.edge-vjs-'+Date.now()),
  '--no-first-run','--no-default-browser-check',
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
await pgc.send('Page.navigate',{url:BASE+'/vjs.html'});
console.log('对照组：未加载扩展');
for(let i=0;i<20;i++){await sleep(500);
  const c=await pgc.send('Runtime.evaluate',{expression:'!!window.__ready',returnByValue:true});
  if(c.result?.result?.value===true)break;}
const b=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({rs:document.querySelector('video').readyState,
  d:document.querySelector('video').duration||0, ev:window.__events})`,returnByValue:true});
console.log('初始:',b.result?.result?.value,'（readyState 应为 0，表示未加载）');

// 等扩展通过点击播放按钮触发加载并播完（最多 45 秒）
let ok=false;
for(let i=0;i<25;i++){await sleep(1000);
  const s=await pgc.send('Runtime.evaluate',{expression:`JSON.stringify({
    rs:document.querySelector('video').readyState,
    ended:document.querySelector('video').ended,
    t:+document.querySelector('video').currentTime.toFixed(1),
    ev:window.__events})`,returnByValue:true});
  const d=JSON.parse(s.result?.result?.value||'{}');
  if(d.ended){ok=true;console.log('播完 @'+d.t+'s');break;}
  if(i%8===0)console.log('  等待… rs='+d.rs+' t='+d.t+' ev='+(d.ev||[]).join(','));}
const a=await pgc.send('Runtime.evaluate',{expression:'JSON.stringify(window.__events)',returnByValue:true});
console.log('事件:',a.result?.result?.value);
const clicked=(JSON.parse(a.result?.result?.value||'[]')||[]).includes('btn-clicked');
console.log('');
console.log(ok&&clicked?'对照组结果：加载并播完（说明页面自己会播，测试无效）'
  :'对照组结果：仍停在未加载（符合预期，扩展才是关键）');
pgc.sock.close();proc.kill();server.close();process.exit(0);
