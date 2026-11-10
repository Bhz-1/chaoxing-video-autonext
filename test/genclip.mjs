// 生成一个真实的 webm 文件（通过浏览器 MediaRecorder 录制），供 HTTP 提供给页面
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import path from 'node:path';

const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const here=path.dirname(fileURLToPath(import.meta.url));
const CDP=9420;
const proc=spawn(EDGE,['--remote-debugging-port='+CDP,'--user-data-dir='+path.join(here,'.edge-gen-'+Date.now()),
  '--no-first-run','--no-default-browser-check','--headless=new','about:blank'],{stdio:'ignore'});
async function targets(){for(let i=0;i<60;i++){await sleep(400);try{return await (await fetch('http://127.0.0.1:'+CDP+'/json/list')).json();}catch(_){}}return[];}
const list=await targets();
const page=list.find(t=>t.type==='page');
const sock=new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const ready=new Promise((r,j)=>{sock.addEventListener('open',r);sock.addEventListener('error',j);});
sock.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}});
const send=(me,pa={})=>{const i=++id;return new Promise(r=>{pend.set(i,r);sock.send(JSON.stringify({id:i,method:me,params:pa}));});};
await ready;
await send('Runtime.enable');
const r = await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`
(async () => {
  const c = document.createElement('canvas'); c.width=320; c.height=180;
  const ctx = c.getContext('2d');
  const st = c.captureStream(20);
  const rec = new MediaRecorder(st, {mimeType:'video/webm;codecs=vp8'});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = res; });
  rec.start();
  const t0 = performance.now();
  await new Promise(res => {
    (function draw(){
      const t = (performance.now()-t0)/1000;
      ctx.fillStyle = 'hsl(' + ((t*90)%360) + ',60%,45%)';
      ctx.fillRect(0,0,320,180);
      ctx.fillStyle = '#fff'; ctx.font = '18px sans-serif';
      ctx.fillText('t='+t.toFixed(2), 12, 90);
      if (t < 5) requestAnimationFrame(draw); else res();
    })();
  });
  rec.stop(); await done;
  const blob = new Blob(chunks, {type:'video/webm'});
  const buf = await blob.arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
})()
`});
const b64 = r.result?.result?.value;
if(!b64){ console.log('FAIL: 未取到视频数据', JSON.stringify(r).slice(0,300)); process.exit(1); }
fs.writeFileSync(path.join(here,'site','clip.webm'), Buffer.from(b64,'base64'));
console.log('已生成 site/clip.webm:', fs.statSync(path.join(here,'site','clip.webm')).size, 'bytes');
sock.close(); proc.kill(); process.exit(0);
