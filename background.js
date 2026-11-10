
/* 视频自动连播 · 后台调度器
 *
 * 设计：决策全部集中在后台。各帧只做两件事：
 *   1) 汇报事实：本帧有哪些视频、播完了没、有没有"下一任务点"、有没有目录项
 *   2) 执行动作：播放指定视频 / 点击指定元素
 * 后台用 chrome.scripting.executeScript(allFrames) 拿到全帧视图后统一决策，
 * 避免多帧各点一次造成"连跳两节"，也能处理"目录与视频分处同级 iframe"的结构。
 */
'use strict';
const VAN_BUILD = 'b11';

const DEFAULT_SETTINGS = {
  enabled: true,
  autoNextVideo: true,
  autoNextSection: true,
  delayMs: 800,
  unmute: false,
  requireCompletion: false,   // 默认关闭：只要求视频播完，不做 90% 门槛
  replayToComplete: false
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let logBuffer = [];
function pushLog(entry) {
  logBuffer.unshift(Object.assign({ at: Date.now() }, entry));
  if (logBuffer.length > 40) logBuffer.length = 40;
  try { chrome.storage.local.set({ vanLog: logBuffer }); } catch (_) {}
}

async function getSettings() {
  const d = await chrome.storage.local.get({ vanSettings: DEFAULT_SETTINGS });
  return Object.assign({}, DEFAULT_SETTINGS, d.vanSettings || {});
}

async function execAllFrames(tabId, fn) {
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: fn });
    return (out || []).filter(r => r && r.result).map(r => Object.assign({ frameId: r.frameId }, r.result));
  } catch (_) {
    return [];
  }
}

/* 全帧快照：每帧报告自己的能力和"下一步能做什么" */
async function snapshot(tabId) {
  return await execAllFrames(tabId, function () {
    const api = window.__VAN;
    if (!api || !api.snapshot) return null;
    return api.snapshot();
  });
}

/* 执行动作：在指定 frame 上调用 */
async function actOnFrame(tabId, frameId, action) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: function (a) {
        const api = window.__VAN;
        if (!api) return null;
        if (a.kind === 'play') return api.playIndex(a.index);
        if (a.kind === 'replay') return api.replay(a.index);
        if (a.kind === 'nextTask') return api.doNextTask();
        if (a.kind === 'nextSection') return api.doNextSection();
        if (a.kind === 'tab') return api.doTab(a.index);
        if (a.kind === 'popupNext') return api.popupNext();
        return null;
      },
      args: [action]
    });
    return (out || [])[0]?.result || null;
  } catch (_) {
    return null;
  }
}

/* 决策核心 */
async function tick(tabId, reason) {
  const s = await getSettings();
  if (!s.enabled) return { ok: false, why: 'disabled' };

  const frames = (await snapshot(tabId)).filter(Boolean);
  if (!frames.length) return { ok: false, why: 'no-frames' };

  // A) 有帧正在播放 -> 什么都不做
  if (frames.some(f => f.playing)) return { ok: true, why: 'playing' };

  // A2) 超星弹了"当前章节还有任务点未完成" -> 点它的「下一节」继续连播。
  //     这个弹窗本身就是超星在问"是否去下一节"，点「下一节」是它给的正规出口；
  //     「去学习」会跳回任务点，自动连播不该点它。
  const popupFrame = frames.find(f => f.popupOpen);
  if (popupFrame) {
    if (popupFrame.popupNext) {
      const r = await actOnFrame(tabId, popupFrame.frameId, { kind: 'popupNext' });
      if (r) {
        pushLog({ kind: 'popupNext', label: '任务点未完成提示->下一节', url: popupFrame.url });
        await sleep(600);
        return { ok: true, why: 'popup-next' };
      }
    }
    // 弹窗在但没有可点的「下一节」：等一会儿，别乱点
    return { ok: false, why: 'popup-no-next' };
  }

  // B) 有帧还有没播过的视频 -> 播放它（同一帧内连续播放多个视频）
  for (const f of frames) {
    if (f.nextVideoIndex >= 0) {
      const r = await actOnFrame(tabId, f.frameId, { kind: 'play', index: f.nextVideoIndex });
      if (r) {
        pushLog({ kind: 'play', label: '视频#' + f.nextVideoIndex, url: f.url });
        return { ok: true, why: 'play-video' };
      }
    }
  }

  // C) 观看时长不足 -> 补看（不跳）
  if (s.requireCompletion) {
    for (const f of frames) {
      if (f.blockedVideoIndex >= 0) {
        const r = await actOnFrame(tabId, f.frameId, { kind: 'replay', index: f.blockedVideoIndex });
        if (r) {
          pushLog({ kind: 'replay', label: '补看观看到 90%', url: f.url });
          return { ok: true, why: 'replay' };
        }
      }
    }
  }

  // 整页（所有帧加起来）一个视频都没有时，才谈得上"视频没加载/落在非视频标签"。
  // 注意：外层小节帧本身 videoCount=0 是正常的，视频在它下面的子 iframe 里。
  const totalVideos = frames.reduce((n, f) => n + (f.videoCount || 0), 0);
  if (totalVideos === 0) {
    // C2) 有"视频学习"标签但没选中 -> 切过去
    for (const f of frames) {
      if (f.hasVideoTab && f.videoTabIndex >= 0) {
        const r = await actOnFrame(tabId, f.frameId, { kind: 'tab', index: f.videoTabIndex });
        if (r) {
          pushLog({ kind: 'tab', label: r.label || '视频学习', url: f.url });
          scheduleTakeover(tabId, 10);
          return { ok: true, why: 'switch-video-tab' };
        }
      }
    }
    // C3) 有视频学习标签但视频仍在加载 -> 等一下，绝不切小节（否则跳过整节视频）
    if (frames.some(f => f.hasVideoTab)) {
      scheduleTakeover(tabId, 10);
      return { ok: false, why: 'waiting-video-tab' };
    }
    // C4) 只有测验/阅读标签的纯图文小节 -> 允许继续走"下一节"
  }

  // D0) 视频完成度闸门
  //     权威判据是 <video> 元素自身状态，不是站点的 ans-job-finished：
  //     站点会在视频刚开播/看了一部分时就把任务点标成完成，
  //     只看它会导致"视频还在播就去切小节"，把正在播的视频打断。
  const xxFrame = frames.find(f => f.xxTasks);
  const videoFrames = frames.filter(f => f && f.videoCount > 0);

  // 还有视频没播完？(currentTime < duration)
  const unfinished = videoFrames.filter(f => f.playing || f.pausedVideoIndex >= 0);

  if (unfinished.length) {
    // 超时保护：连续 10 分钟都停在这里（例如某个视频帧加载失败），
    // 就放弃等待继续往下走，避免整门课永久卡死。
    const now0 = Date.now();
    if (!videoStallSince.has(tabId)) videoStallSince.set(tabId, now0);
    if (now0 - videoStallSince.get(tabId) > 10 * 60 * 1000) {
      pushLog({ kind: 'timeout', label: '视频长时间未完成，跳过' });
      videoStallSince.delete(tabId);
    } else {
    // 有正在播的 -> 等它播完
    if (frames.some(f => f.playing)) return { ok: true, why: 'video-in-progress' };
    // 全暂停、还有没播完的 -> 启动它
    for (const f of unfinished) {
      if (f.pausedVideoIndex >= 0) {
        const r = await actOnFrame(tabId, f.frameId, { kind: 'play', index: f.pausedVideoIndex });
        if (r) { pushLog({ kind: 'play', label: '未播完的视频', url: f.url }); return { ok: true, why: 'pending-video-play' }; }
      }
    }
    scheduleTakeover(tabId, 12);
    return { ok: false, why: 'pending-video' };
    }
  } else {
    videoStallSince.delete(tabId);
  }

  // 视频都播完了。站点若还认为有未完成任务点，交给它自己的弹窗/下一节处理。
  if (xxFrame) {
    const t = xxFrame.xxTasks;
    if (t.videoTotal > 0 && t.videoDone < t.videoTotal) {
      pushLog({ kind: 'note', label: '视频已播完但站点未标记完成，继续' });
    }
  }

  // D) 有帧能点"下一任务点" -> 点它
  for (const f of frames) {
    if (f.canNextTask) {
      const r = await actOnFrame(tabId, f.frameId, { kind: 'nextTask' });
      if (r) {
        pushLog({ kind: 'nextTask', label: r.label || '', url: f.url });
        return { ok: true, why: 'next-task' };
      }
    }
  }

  // E) 有帧能切"下一小节" -> 切（只切一帧，且切完进入冷却，避免连跳）
  if (s.autoNextSection) {
    for (const f of frames) {
      if (f.canNextSection) {
        const now = Date.now();
        if (now - (sectionCooldown.get(tabId) || 0) < 5000) return { ok: false, why: 'cooldown' };
        sectionCooldown.set(tabId, now);
        const r = await actOnFrame(tabId, f.frameId, { kind: 'nextSection' });
        if (r) {
          pushLog({ kind: 'nextSection', label: r.label || '', url: f.url });
          scheduleTakeover(tabId, 12);
          return { ok: true, why: 'next-section' };
        }
      }
    }
  }

  pushLog({ kind: 'idle' });
  return { ok: false, why: 'nothing-to-do' };
}

const videoStallSince = new Map();   // tabId -> 首次发现"未播完"的时间

const sectionCooldown = new Map();
const takeoverTimers = new Map();

/* 切完小节后，帮新出现的视频启动播放。
 * 约束（否则画面会抽搐）：
 *   1) 只要有一个视频在播，就立刻停手，不再碰其它视频
 *   2) 同一帧里的同一个视频只尝试一次，绝不反复 play()
 *   3) 只看"真正待播"的 pausedVideoIndex（content.js 里已排除已播完/已播过的）
 */
function scheduleTakeover(tabId, tries) {
  const existing = takeoverTimers.get(tabId);
  if (existing) clearInterval(existing);

  const attempted = new Set();   // frameId:index
  let n = 0;

  const timer = setInterval(async () => {
    n++;
    if (n > tries) { clearInterval(timer); takeoverTimers.delete(tabId); return; }

    const frames = await snapshot(tabId);
    if (!frames.length) return;

    // 已经有视频在播 -> 什么都不做（这是关键：不要打断正在播的视频）
    if (frames.some(f => f && f.playing)) {
      clearInterval(timer);
      takeoverTimers.delete(tabId);
      return;
    }

    // 每轮最多启动一个，启动成功就停手
    for (const f of frames) {
      if (!f || f.pausedVideoIndex < 0) continue;
      const key = f.frameId + ':' + f.pausedVideoIndex;
      if (attempted.has(key)) continue;
      attempted.add(key);
      const r = await actOnFrame(tabId, f.frameId, { kind: 'play', index: f.pausedVideoIndex });
      if (r) { clearInterval(timer); takeoverTimers.delete(tabId); return; }
    }
  }, 1200);

  takeoverTimers.set(tabId, timer);
}

/* ---------------- 自驱守护 ----------------
 * 只在"有视频但全部暂停、且没有弹窗"时才动手，用来接管：
 *   - 刚进入小节时首个视频不会自动播
 *   - 被浏览器暂停
 * 频率低（3 秒），且每标签页有自己的时间戳，避免狂刷。
 */
const lastWatch = new Map();

async function watchdogTick(tabId) {
  const now = Date.now();
  if (now - (lastWatch.get(tabId) || 0) < 3000) return;
  lastWatch.set(tabId, now);

  const s = await getSettings();
  if (!s.enabled) return;

  const frames = await snapshot(tabId);
  if (!frames.length) return;

  // 有弹窗 -> 交给正常逻辑处理，这里不抢
  if (frames.some(f => f && f.popupOpen)) return;

  // 有视频在播 -> 不启动第二个。
  // 注意：超星会把整节的任务点都预加载成 iframe，所以"有帧在播"不一定是当前要看的那一个；
  // 但只要真的有东西在播，就说明平台自己在推进，不该插手中断它。
  if (frames.some(f => f && f.playing)) return;

  const totalVideos = frames.reduce((n, f) => n + (f.videoCount || 0), 0);
  if (totalVideos === 0) return;

  // 只在"当前小节尚未完成"时才启动，避免去播预加载的后续任务点
  const xx = frames.find(f => f.xxTasks);
  if (xx && xx.xxTasks && xx.xxTasks.videoTotal > 0 && xx.xxTasks.videoDone >= xx.xxTasks.videoTotal) {
    return;   // 本小节视频都已播完，交给 tick 去切下一节
  }

  // 挑一个"真正待播"的视频起播（优先没有 vanPlayed 标记的）
  const playable = frames.filter(f => f && f.pausedVideoIndex >= 0);
  if (!playable.length) return;
  const target = playable[0];

  const r = await actOnFrame(tabId, target.frameId, { kind: 'play', index: target.pausedVideoIndex });
  if (r) pushLog({ kind: 'watchdog', label: '自动启动视频', url: target.url });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  setTimeout(() => watchdogTick(tabId).catch(() => {}), 2000);
});

/* 心跳：用 alarms（MV3 官方周期性任务）代替 setInterval，
 * 保证 service worker 被回收后仍能定期检查"视频卡在暂停"。
 */
chrome.alarms.create('van-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'van-heartbeat') return;
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (!t.url || !/^https?:/.test(t.url)) continue;
      watchdogTick(t.id).catch(() => {});
    }
  });
});

/* 消息入口 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === 'van:videoEnded') {
    if (tabId == null) { sendResponse({ ok: false }); return; }
    // 稍等，让播放器把状态稳定下来再决策
    setTimeout(() => tick(tabId, 'ended').then(r => sendResponse(r)).catch(() => sendResponse({ ok: false })), 300);
    return true;
  }

  if (msg.type === 'van:manualTick') {
    const id = msg.tabId != null ? msg.tabId : tabId;
    tick(id, 'manual').then(r => sendResponse(r)).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'van:stuck') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      lastWatch.delete(tabId);           // 绕过频率限制，立刻处理
      watchdogTick(tabId).catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'van:frameReady') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) setTimeout(() => watchdogTick(tabId).catch(() => {}), 800);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'van:ping') { sendResponse({ ok: true }); return; }

  if (msg.type === 'van:getLog') {
    chrome.storage.local.get({ vanLog: [] }, d => sendResponse({ log: d.vanLog || [] }));
    return true;
  }

  if (msg.type === 'van:clearLog') {
    logBuffer = [];
    chrome.storage.local.set({ vanLog: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

/* 标签页导航完成后也做一次巡检（切小节可能整页跳转） */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  setTimeout(() => tick(tabId, 'tab-updated').catch(() => {}), 1200);
});
