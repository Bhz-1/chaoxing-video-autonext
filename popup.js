'use strict';
const DEF = { enabled: true, autoNextVideo: true, autoNextSection: true, delayMs: 800, unmute: false };
const $ = (id) => document.getElementById(id);

function render(s) {
  $('enabled').checked = !!s.enabled;
  $('autoNextVideo').checked = !!s.autoNextVideo;
  $('autoNextSection').checked = !!s.autoNextSection;
  $('delayMs').value = s.delayMs;
  $('delayVal').textContent = s.delayMs + 'ms';
  $('unmute').checked = !!s.unmute;
  document.body.classList.toggle('off', !s.enabled);
}

async function save() {
  const s = {
    enabled: $('enabled').checked,
    autoNextVideo: $('autoNextVideo').checked,
    autoNextSection: $('autoNextSection').checked,
    delayMs: Number($('delayMs').value),
    unmute: $('unmute').checked
  };
  $('delayVal').textContent = s.delayMs + 'ms';
  await chrome.storage.local.set({ vanSettings: s });
}

async function loadLog() {
  const d = await chrome.storage.local.get({ vanLog: [] });
  const lines = (d.vanLog || []).slice(0, 12).map(e => {
    const t = new Date(e.at).toLocaleTimeString();
    if (e.kind === 'advance') {
      const lv = e.level === 'section' ? '下一小节' : (e.level === 'task' ? '下一任务点' : '下一视频');
      return t + ' ' + lv + ' ' + (e.label || '');
    }
    if (e.kind === 'exhausted') return t + ' 没有更多了';
    return t + ' ' + e.kind;
  });
  $('log').textContent = lines.length ? lines.join('\n') : '暂无记录';
}

(async function init() {
  const d = await chrome.storage.local.get({ vanSettings: DEF });
  render(Object.assign({}, DEF, d.vanSettings || {}));
  await loadLog();
})();

['enabled', 'autoNextVideo', 'autoNextSection', 'unmute'].forEach(id => $(id).addEventListener('change', save));
$('delayMs').addEventListener('input', save);

$('advance').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  $('state').textContent = '...';
  chrome.runtime.sendMessage({ type: 'van:manualAdvance', tabId: tab.id }, (r) => {
    $('state').textContent = r && r.ok ? '已切换' : '没有更多';
    setTimeout(loadLog, 400);
  });
});
setInterval(loadLog, 1500);
