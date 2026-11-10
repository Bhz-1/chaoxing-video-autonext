
/* 视频自动连播 · 内容脚本（每帧一个）
 *
 * 职责很窄：
 *   - 上报事实：snapshot() 告诉后台本帧有几个视频、谁在播、谁播完了、
 *     能不能点"下一任务点"、能不能切"下一小节"、有没有"视频学习"标签
 *   - 执行动作：playIndex / doNextTask / doNextSection / doTab
 * 所有"该轮到谁"的判断都在 background.js，避免多帧各点一次造成连跳。
 */
(() => {
  'use strict';
  if (window.__VAN_READY__) return;
  window.__VAN_READY__ = true;

  const S = {
    settings: { enabled: true, delayMs: 800, unmute: false, requireCompletion: false, replayToComplete: false },
    handled: new WeakMap(),      // video -> 已上报播完的时间
    lastPlayedAt: 0,
    userPausedAt: 0
  };

  const log = (...a) => { try { console.log('[VAN]', ...a); } catch (_) {} };

  try {
    chrome.storage.local.get({ vanSettings: null }, (d) => {
      if (d && d.vanSettings) Object.assign(S.settings, d.vanSettings);
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.vanSettings && ch.vanSettings.newValue) Object.assign(S.settings, ch.vanSettings.newValue);
    });
  } catch (_) {}

  /* ---------------- 基础工具 ---------------- */
  const cls = (el) => {
    if (!el || !el.className) return '';
    return typeof el.className === 'string' ? el.className : (el.className.baseVal || '');
  };
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && parseFloat(st.opacity) !== 0;
  };
  const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, '') : '');
  const labelOf = (el) => (text(el).slice(0, 40) || cls(el).slice(0, 40));

  const clickEl = (el) => {
    if (!el || !visible(el)) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    const inner = el.querySelector && el.querySelector('a,button,[role="button"]');
    const t = inner && visible(inner) ? inner : el;
    // 只触发一次点击：.click() + dispatchEvent 会让站点回调执行两遍（连跳两节）
    try {
      if (typeof t.click === 'function') t.click();
      else t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    return true;
  };

  // 超星目录项的选中类是 posCatalog_active（"active" 前没有分隔符），
  // 所以这里既要支持 xxx-active 这种，也要支持 posCatalog_active / isActive 这类拼接写法。
  const ACTIVE_RE = /(active|current|selected|playing|checked|on)$|[-_\s](active|current|selected|playing|checked)$|^(active|current|selected)$/i;
  const isActive = (el) => {
    if (!el) return false;
    if (ACTIVE_RE.test(cls(el))) return true;
    if (el.getAttribute) {
      const ac = el.getAttribute('aria-current');
      if (ac && ac !== 'false') return true;
      if (el.getAttribute('aria-selected') === 'true') return true;
      if (el.getAttribute('data-active') === 'true') return true;
    }
    return false;
  };
  const isDisabled = (el) => {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return /disabled|notAllowed|forbid/i.test(cls(el));
  };

  /* ---------------- 观看覆盖率（平台要求 ≥90%） ---------------- */
  const covState = new WeakMap();
  const COVERAGE_FALLBACK = 0.9;

  const requiredRatio = () => {
    let w = window;
    for (let i = 0; i < 4 && w; i++) {
      try {
        const t = w.document && w.document.body ? (w.document.body.innerText || '') : '';
        const m = t.match(/(?:观看时长|学习时长|视频时长|观看进度)[^%\n]{0,60}?(\d{1,3})\s*%/);
        if (m) {
          const r = Number(m[1]) / 100;
          if (r > 0 && r <= 1) return r;
        }
      } catch (_) {}
      if (w === w.parent) break;
      try { w = w.parent; } catch (_) { break; }
    }
    return COVERAGE_FALLBACK;
  };

  const ensureCoverage = (v) => {
    let c = covState.get(v);
    if (c) return c;
    // seen[i]=1 表示"这一段（0.25s）确实自然播放过"
    // 判断是否达标用"从 0 开始连续覆盖到的最大位置"，而不是总覆盖量：
    // 拖到结尾再放几秒，总覆盖量可能接近总时长，但前面大段没看，不能算完成。
    c = { dur: 0, seen: null, covered: 0, last: null, fromStart: false, contig: 0 };
    covState.set(v, c);

    const STEP = 0.25;
    const init = () => {
      if (c.seen || !v.duration || !isFinite(v.duration) || v.duration <= 0) return;
      c.dur = v.duration;
      c.seen = new Uint8Array(Math.ceil(v.duration / STEP) + 2);
    };
    const mark = (from, to) => {
      if (!c.seen || !isFinite(from) || !isFinite(to) || to <= from) return;
      const a = Math.max(0, Math.floor(from / STEP));
      const b = Math.min(c.seen.length, Math.ceil(to / STEP));
      for (let i = a; i < b; i++) if (!c.seen[i]) { c.seen[i] = 1; c.covered += STEP; }
      // 重算"从头连续"的长度
      let k = 0;
      while (k < c.seen.length && c.seen[k]) k++;
      c.contig = k * STEP;
    };

    v.addEventListener('loadedmetadata', init);
    v.addEventListener('durationchange', init);
    v.addEventListener('play', () => {
      init();
      if (c.last === null) { c.last = v.currentTime; c.fromStart = v.currentTime < 3; }
    });
    // 跳转到别处时，连续覆盖要从新位置重新起算（不能把"跳过去"当成"看过"）
    v.addEventListener('seeking', () => {
      c.last = v.currentTime;
      c.seekAt = v.currentTime;
    });
    v.addEventListener('timeupdate', () => {
      init();
      if (c.last === null) { c.last = v.currentTime; c.fromStart = v.currentTime < 3; return; }
      const dt = v.currentTime - c.last;
      if (!v.seeking && dt > 0 && dt < 2) mark(c.last, v.currentTime);
      c.last = v.currentTime;
    });
    // 兜底：用 play -> pause/ended 的墙钟时间补记
    let t0 = 0;
    v.addEventListener('playing', () => { t0 = Date.now(); });
    const flush = () => {
      if (!t0) return;
      const played = (Date.now() - t0) / 1000; t0 = 0;
      init();
      mark(Math.max(0, (v.currentTime || 0) - played), v.currentTime || 0);
    };
    v.addEventListener('pause', flush);
    v.addEventListener('ended', flush);
    if (v.duration) init();
    if (!v.paused) t0 = Date.now();
    return c;
  };

  const coverageShortfall = (v) => {
    const c = covState.get(v);
    if (!c || !c.dur || !c.fromStart) return 0;
    const need = c.dur * requiredRatio();
    // 用"从头连续覆盖"判定：跳着看/拖到末尾都不算看完
    return c.contig >= need - 0.5 ? 0 : need - c.contig;
  };

  /* ---------------- 视频 ---------------- */
  const videos = () => Array.from(document.querySelectorAll('video')).filter(v => v.isConnected);
  const isDead = (v) => !v || v.ended ||
    (v.duration && isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.3 && v.paused);

  /* 超星用 video.js 播放器：<video> 有 src 但 readyState=0（没加载），
   * 必须先点那个大播放按钮（.vjs-big-play-button），播放器才会去拉流。
   * 只调 video.play() 在未加载时是无效的，视频会永远停在 0 秒。
   */
  const clickVideoJsPlay = (v) => {
    try {
      const box = v.closest('.video-js, .vjs-tech') ? (v.closest('.video-js') || v.parentElement) : v.parentElement;
      if (!box) return false;
      const btn = box.querySelector('.vjs-big-play-button, button.vjs-big-play-button');
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { btn.click(); return true; }
      }
      // 有些皮肤把按钮做成覆盖层
      const overlay = box.querySelector('.vjs-poster, .vjs-big-play-centered');
      if (overlay) { overlay.click(); return true; }
    } catch (_) {}
    return false;
  };

  const playIndex = (i) => {
    const list = videos();
    const v = list[i];
    if (!v) return null;

    // 拒绝"已经播完"的视频
    if (v.ended) return null;
    if (v.duration && isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.5) return null;

    // 播放互斥：同一帧里已有别的视频在播，就不要起第二个
    if (list.some(x => x !== v && !x.paused && !x.ended)) return null;

    ensureCoverage(v);

    // 关键：不要在调用 play() 之前就打 vanPlayed 标记。
    // 之前就是先打标记，一旦 play() 被浏览器/播放器拒绝，视频没播起来但标记已置位，
    // 之后 pausedVideoIndex 会永久跳过它 —— 表现就是"停在某一秒再也动不了"。
    // 现在改为：先试播，确认真的开始播了才打标记。
    const markStarted = () => { v.dataset.vanPlayed = '1'; S.lastPlayedAt = Date.now(); };

    // 还没加载（readyState 0）时，先点 video.js 的播放按钮让它开始拉流
    if (v.readyState === 0) clickVideoJsPlay(v);

    try {
      if (S.settings.unmute) v.muted = false;
      const p = v.play();
      if (p && typeof p.then === 'function') {
        p.then(() => markStarted()).catch(() => {
          // 有声自动播放被拦截 -> 静音重试
          try {
            v.muted = true;
            const p2 = v.play();
            if (p2 && typeof p2.then === 'function') p2.then(() => markStarted()).catch(() => {});
            else markStarted();
          } catch (_) {}
        });
      } else {
        markStarted();
      }
      // play() 是异步的，但同步返回时 paused 通常已变成 false
      if (!v.paused) markStarted();
      return { ok: true, index: i };
    } catch (_) { return null; }
  };

  /* ---------------- 超星任务点状态 ----------------
   * 真实结构：knowledge/cards 帧里，每个任务点是一个 .ans-attach-ct，
   * 完成的会被打上 .ans-job-finished。这是站点自己给的权威判断，
   * 比自己算"看了多久"更可靠，两者结合用。
   */
  const isXingxingPage = () => {
    if (/chaoxing\.com/.test(location.hostname)) return true;
    try { return /chaoxing\.com/.test(window.top.location.hostname); } catch (_) { return false; }
  };

  // 任务点统计。关键区分：
  //   videoTotal/videoDone —— 只数"视频类"任务点（用户只关心视频是否都播完）
  //   total/done          —— 全部任务点（测验、阅读等也算），仅供展示
  const xingxingTaskStats = () => {
    const all = Array.from(document.querySelectorAll('.ans-attach-ct'));
    if (!all.length) return null;
    const videos = all.filter(el =>
      el.querySelector('iframe.ans-insertvideo-online, iframe[src*="/modules/video/"]'));
    const countDone = (arr) => arr.reduce((n, el) => n + (/ans-job-finished/.test(cls(el)) ? 1 : 0), 0);
    return {
      total: all.length,
      done: countDone(all),
      videoTotal: videos.length,
      videoDone: countDone(videos)
    };
  };

  // 找出第一个"还没完成"的视频任务点对应的 iframe
  const xingxingPendingVideoFrame = () => {
    const list = Array.from(document.querySelectorAll('.ans-attach-ct'));
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (/ans-job-finished/.test(cls(el))) continue;
      if (!el.querySelector('iframe')) continue;
      return { index: i, el };
    }
    return null;
  };

  /* ---------------- 标签页（视频学习/章节测验/拓展阅读/拓展视野） ---------------- */
  const VIDEO_TAB_RE = /(视频学习|观看视频|学习视频|视频讲解)/;
  const QUIZ_TAB_RE = /(章节测验|测验|答题|测试)/;
  const NAV_WORD_RE = /(上一|下一|返回|目录)$/;

  const tabCandidates = () => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,li,span,div,[role="tab"]')) {
      if (!visible(el)) continue;
      let childWithText = false;
      for (const ch of el.children) if (visible(ch) && text(ch)) { childWithText = true; break; }
      if (childWithText && !el.getAttribute('role') && !el.getAttribute('data-tab')) continue;
      const t = text(el);
      if (!t || t.length > 14 || NAV_WORD_RE.test(t)) continue;
      out.push({ el, t });
    }
    return out;
  };
  const tabActive = (el) => {
    if (!el) return false;
    if (isActive(el)) return true;
    const p = el.parentElement;
    return !!(p && p.children.length <= 3 && isActive(p));
  };

  const videoTabIndex = () => {
    const cands = tabCandidates();
    let idx = -1, n = 0;
    for (const c of cands) {
      if (!VIDEO_TAB_RE.test(c.t)) continue;
      if (!tabActive(c.el) && idx < 0) idx = n;
      n++;
    }
    return n ? idx : -1;
  };
  const hasVideoTab = () => tabCandidates().some(c => VIDEO_TAB_RE.test(c.t));
  const hasQuizTab = () => tabCandidates().some(c => QUIZ_TAB_RE.test(c.t));

  const doTab = (i) => {
    const cands = tabCandidates().filter(c => VIDEO_TAB_RE.test(c.t));
    const c = cands[i >= 0 ? i : 0];
    if (!c) return null;
    clickEl(c.el);
    return { ok: true, label: c.t };
  };

  /* ---------------- 下一任务点 ---------------- */
  const NEXT_TASK_RE = /^(下一(个)?任务点|下一个视频|下一段视频|下一讲|下一课|下一集|下集|下一节(课)?|继续学习|学习下一节|下一任务)$/;
  const NEXT_TASK_SELECTORS = [
    '#prevNextFocusNext',                    // 超星真实：div.jb_btn.prev_next
    '.prev_next.next', '.prevNextFocusNext', '[id*="prevNextFocusNext"]',
    '.next_ul a', 'a[title*="下一任务点"]', 'a[title*="下一节"]', 'button[title*="下一节"]',
    'div.jb_btn[onclick*="next"]'
  ];
  const TASK_LIST_SELECTORS = ['.prev_ul li', '.orientation li', '[class*="taskPoint"] li'];

  const findNextTask = () => {
    for (const sel of NEXT_TASK_SELECTORS) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      for (const el of list) if (visible(el) && !isDisabled(el)) return el;
    }
    for (const el of document.querySelectorAll('a,button,[role="button"],li,span')) {
      if (!visible(el) || isDisabled(el)) continue;
      const t = text(el);
      if (!t || t.length > 16 || !NEXT_TASK_RE.test(t)) continue;
      if (/上一|返回/.test(t)) continue;
      return el;
    }
    for (const sel of TASK_LIST_SELECTORS) {
      let items = [];
      try { items = Array.from(document.querySelectorAll(sel)).filter(visible); } catch (_) { continue; }
      if (items.length < 2) continue;
      const i = items.findIndex(isActive);
      if (i >= 0 && i < items.length - 1) return items[i + 1];
    }
    return null;
  };

  /* ---------------- 下一小节（目录） ---------------- */
  const CATALOG_SELECTORS = [
    '.posCatalog_select',            // 超星真实结构
    '.posCatalog_select:not(.firstLayer)',
    '#catalog_ul > li', '.catalog_list > li', '.chapter_list > li',
    '.chapter-item', '.chapter_item', '.catalog-item', '[data-chapterid]', '.catalog li'
  ];
  const CATALOG_RE = /(catalog|chapter|section|menu|list|nav|tree|ztl|directory)/i;

  const inCatalogContainer = (el) => {
    let p = el, i = 0;
    while (p && i++ < 6) { if (CATALOG_RE.test(cls(p))) return true; p = p.parentElement; }
    return false;
  };

  const nextSiblingOfActive = () => {
    const actives = Array.from(document.querySelectorAll('li,a,div'))
      .filter(el => visible(el) && isActive(el) && text(el).length > 0 && text(el).length < 80);
    let best = null, bestScore = -1;
    for (const a of actives) {
      const p = a.parentElement;
      if (!p) continue;
      const sibs = Array.from(p.children).filter(visible);
      if (sibs.length < 2) continue;
      let score = sibs.length + (CATALOG_RE.test(cls(p)) ? 50 : 0) + (inCatalogContainer(p) ? 30 : 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (!best) return null;
    const sibs = Array.from(best.parentElement.children).filter(visible);
    const i = sibs.indexOf(best);
    return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null;
  };

  // 超星目录里有两类项，必须区分：
  //   div.posCatalog_select.firstLayer  -> 专题标题行（如"6 专题六 ..."），点它只会折叠/展开专题
  //   div.posCatalog_select#cur<id>     -> 真正的小节（如"6.1 课前学习"）
  // 若把标题行当成"下一节"去点，就永远进不了下一小节——这是"扩展没生效"的根因。
  const isCatalogGroupHeader = (el) => {
    if (!el) return false;
    if (/firstLayer/i.test(cls(el))) return true;
    const id = el.id || '';
    if (id && !/^cur/i.test(id)) return true;   // 真实小节 id 都是 cur 开头
    return false;
  };

  const findNextSection = () => {
    for (const sel of CATALOG_SELECTORS) {
      let items = [];
      try { items = Array.from(document.querySelectorAll(sel)).filter(visible); } catch (_) { continue; }
      if (items.length < 2) continue;
      // 只保留真正的小节项
      const leaves = items.filter(it => !isCatalogGroupHeader(it));
      if (leaves.length < 2) continue;
      let i = leaves.findIndex(isActive);
      if (i < 0) i = leaves.findIndex(it => it.querySelector('.active,.current,.selected,[class*="active"],[class*="current"]'));
      if (i < 0) continue;
      if (i < leaves.length - 1) return leaves[i + 1];
    }
    // 兜底路径同样排除专题标题行，否则会点到"6 专题六 ..."这种只能折叠的项
    const sib = nextSiblingOfActive();
    if (sib && inCatalogContainer(sib) && !isCatalogGroupHeader(sib)) return sib;
    return null;
  };

  /* ---------------- 播完上报 ---------------- */
  // 自主补看的进度：同一个视频已经补看几次
  const replays = new WeakMap();

  const reportEnded = (v) => {
    if (!S.settings.enabled || !v) return;
    const now = Date.now();
    const prev = S.handled.get(v);
    if (prev && now - prev < 30 * 60 * 1000) return;
    S.handled.set(v, now);
    ensureCoverage(v);

    // 关键：先在帧内检查观看时长是否达到平台要求。
    // 达不到就自己补看，绝不把"播完了"上报给后台——否则后台会直接切下一节，
    // 而平台判定该任务点未完成（"未完成任务点前，当前视频不可切换"）。
    if (S.settings.requireCompletion) {
      const gap = coverageShortfall(v);
      if (gap > 0) {
        const times = replays.get(v) || 0;
        if (S.settings.replayToComplete && times < 3) {
          replays.set(v, times + 1);
          try {
            v.currentTime = Math.max(0, v.duration - Math.max(gap, 1) - 0.5);
            log('观看时长不足 ' + Math.ceil(gap) + 's，自动补看');
            const p = v.play();
            if (p && p.catch) p.catch(() => { try { v.muted = true; v.play().catch(() => {}); } catch (_) {} });
            S.handled.delete(v);   // 补看结束后还要再判断一次
            return;
          } catch (_) {}
        }
        log('观看时长不足且无法补看，停在这里不跳转');
        return;
      }
    }

    log('视频播完，上报后台');
    try { chrome.runtime.sendMessage({ type: 'van:videoEnded', frameUrl: location.href }); } catch (_) {}
  };

  document.addEventListener('ended', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') reportEnded(e.target);
  }, true);

  // 兜底：兼容不派发 ended 的播放器
  setInterval(() => {
    if (!S.settings.enabled) return;
    for (const v of videos()) {
      ensureCoverage(v);
      if (!v.duration || !isFinite(v.duration) || v.duration <= 0) continue;
      if (v.currentTime < v.duration - 0.25) continue;
      if (!v.paused && !v.ended) continue;
      if (S.handled.has(v)) continue;
      reportEnded(v);
      break;
    }
  }, 900);

  try {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const fresh = [];
        if (n.tagName === 'VIDEO') fresh.push(n);
        else if (n.querySelectorAll) fresh.push.apply(fresh, n.querySelectorAll('video'));
        for (const v of fresh) { S.handled.delete(v); ensureCoverage(v); }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  /* ---------------- 超星"任务点未完成"拦截弹窗 ----------------
   * 视频播完后超星会弹：div.maskDiv.jobFinishTip > div.popDiv
   *   p.popWord2  : 当前章节还有任务点未完成，是否去完成？
   *   a.nextChapter : 「下一节」  ← 自动连播要点这个
   *   a.popMoveDele : 「去学习」  ← 不要点
   * 注意：页面上还有一份隐藏模板（#jobFinishTip 里的 a.bluebtn02.nextChapter），
   * 必须只点可见的那个，否则点不动。
   */
  const findJobFinishPopup = () => {
    const masks = Array.from(document.querySelectorAll('.maskDiv.jobFinishTip, .maskDiv, #jobFinishTip'));
    for (const m of masks) {
      if (!visible(m)) continue;
      if (!/任务点未完成|是否去完成/.test(text(m))) continue;
      return m;
    }
    return null;
  };

  const isJobFinishPopupOpen = () => !!findJobFinishPopup();

  // 弹窗里的「下一节」：只在可见弹窗内找，且必须是可见元素
  const findPopupNextButton = () => {
    const popup = findJobFinishPopup();
    if (!popup) return null;
    const cands = Array.from(popup.querySelectorAll('a.nextChapter, .nextChapter, a, button'));
    for (const el of cands) {
      if (!visible(el)) continue;
      const t = text(el);
      if (t !== '下一节') continue;
      if (isDisabled(el)) continue;
      return el;
    }
    return null;
  };

  // 关掉弹窗（找不到"下一节"时兜底，避免卡住整页）
  const closeJobFinishPopup = () => {
    const popup = findJobFinishPopup();
    if (!popup) return null;
    const closers = Array.from(popup.querySelectorAll('.layui-layer-close, .close, .popMoveDele, [class*="close"]'));
    for (const el of closers) {
      if (!visible(el)) continue;
      if (text(el) === '去学习') continue;   // 去学习会跳走，别点
      clickEl(el);
      return { closed: true };
    }
    return null;
  };

  /* ---------------- 对外：快照 + 动作 ---------------- */
  // 逐项安全求值：任何一个检查抛错，都不能让整份 snapshot 崩掉。
  // 之前就吃过亏——某辅助函数未定义时 snapshot 整体抛异常，
  // executeScript 静默吞掉，扩展看起来"装了但完全不工作"。
  const safe = (fn, fallback) => {
    try { const r = fn(); return r === undefined ? fallback : r; }
    catch (e) { try { console.warn('[VAN] snapshot 子项失败:', e && e.message); } catch (_) {} return fallback; }
  };

  window.__VAN = {
    snapshot() {
      const vs = safe(() => videos(), []) || [];
      safe(() => vs.forEach(ensureCoverage), null);

      const playingIdx = safe(() => vs.findIndex(v => !v.paused && !v.ended), -1);

      // 可播的下一个视频：暂停中 + 已加载 + 未播完 + 没被标记播过
      const nextVideoIndex = safe(() => {
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i];
          if (!v.paused || v.ended) continue;
          const dur = v.duration;
          if (dur && isFinite(dur) && dur > 0 && v.currentTime >= dur - 0.5) continue;
          return i;
        }
        return -1;
      }, -1);

      // 真正待播的视频（用于"接管新小节"）：排除已播完/已播过的
      // 注意：这里不再因为 vanPlayed 标记就跳过。
      // 标记只表示"我们尝试播过"，不代表"已播完"；用它当禁播理由会导致
      // 视频卡在中间永远不被接手。真正该排除的是"已播完"。
      // 注意：duration=0（未加载）也要报出来。
      // 之前用 `if (!v.duration) continue` 会把"还没加载的视频"永久排除，
      // 而超星的 video.js 恰恰要等点击播放按钮才加载 -> 死锁（有任务点未完成但永远没有可播视频）。
      const pausedVideoIndex = safe(() => {
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i];
          if (!v.paused) continue;
          if (v.ended) continue;
          const dur = v.duration;
          if (dur && isFinite(dur) && dur > 0 && v.currentTime >= dur - 0.5) continue;  // 已播完
          return i;
        }
        return -1;
      }, -1);

      const blockedIndex = safe(() => {
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i];
          if (!v.duration || !isFinite(v.duration) || v.duration <= 0) continue;
          if (v.currentTime < v.duration - 1) continue;
          if (coverageShortfall(v) > 0) return i;
        }
        return -1;
      }, -1);

      const nt = safe(() => findNextTask(), null);
      const ns = safe(() => findNextSection(), null);

      return {
        url: safe(() => location.href, ''),
        title: safe(() => document.title, ''),
        videoCount: vs.length,
        playing: playingIdx >= 0,
        playingIndex: playingIdx,
        nextVideoIndex,
        pausedVideoIndex,
        blockedVideoIndex: blockedIndex,
        canNextTask: safe(() => !!(nt && visible(nt)), false),
        nextTaskLabel: safe(() => (nt ? labelOf(nt) : ''), ''),
        canNextSection: safe(() => !!(ns && visible(ns)), false),
        nextSectionLabel: safe(() => (ns ? labelOf(ns) : ''), ''),
        hasVideoTab: safe(() => hasVideoTab(), false),
        videoTabIndex: safe(() => videoTabIndex(), -1),
        hasQuizTab: safe(() => hasQuizTab(), false),
        xxTasks: safe(() => xingxingTaskStats(), null),
        xxPendingVideo: safe(() => !!xingxingPendingVideoFrame(), false),
        popupOpen: safe(() => isJobFinishPopupOpen(), false),
        popupNext: safe(() => !!findPopupNextButton(), false)
      };
    },

    playIndex(i) { return playIndex(i); },

    doNextTask() {
      const t = findNextTask();
      if (!t || !visible(t)) return null;
      clickEl(t);
      return { ok: true, label: labelOf(t) };
    },

    doNextSection() {
      const s = findNextSection();
      if (!s || !visible(s)) return null;
      clickEl(s);
      return { ok: true, label: labelOf(s) };
    },

    doTab(i) { return doTab(i); },

    // 点"任务点未完成"弹窗里的「下一节」
    popupNext() {
      const btn = findPopupNextButton();
      if (!btn) return null;
      clickEl(btn);
      return { ok: true, label: '弹窗-下一节' };
    },

    popupClose() {
      const r = closeJobFinishPopup();
      return r || null;
    },

    // 补看：把视频拉回到缺口处
    replay(i) {
      const v = videos()[i];
      if (!v || !v.duration) return null;
      const gap = coverageShortfall(v);
      try {
        v.currentTime = Math.max(0, v.duration - Math.max(gap, 1) - 0.5);
        return playIndex(i);
      } catch (_) { return null; }
    },

    debug() {
      const vs = Array.from(document.querySelectorAll('video'));
      return {
        url: location.href,
        ratio: requiredRatio(),
        settings: S.settings,
        videos: vs.map(v => {
          const c = covState.get(v);
          return {
            t: +v.currentTime.toFixed(2), d: +(v.duration || 0).toFixed(2),
            paused: v.paused, ended: v.ended,
            covered: c ? +c.covered.toFixed(2) : null,
            contig: c ? +c.contig.toFixed(2) : null,
            fromStart: c ? c.fromStart : null,
            dur: c ? +c.dur.toFixed(2) : null,
            shortfall: +coverageShortfall(v).toFixed(2)
          };
        }),
        snapshot: window.__VAN.snapshot()
      };
    }
  };

  // 本帧加载好后主动上报一次：让后台立刻知道"这里有视频了"，
  // 不必等 30 秒心跳，也不会漏掉"首个小节视频不会自动播"的情况。
  const announce = (reason) => {
    try { chrome.runtime.sendMessage({ type: 'van:frameReady', reason: reason, url: location.href }); } catch (_) {}
  };
  announce('init');

  // 视频元素出现/开始播放也上报一次（覆盖异步插入的场景）
  let announcedPlay = false;
  setInterval(() => {
    if (announcedPlay) return;
    if (videos().length > 0) { announcedPlay = true; announce('videos-present'); }
  }, 800);

  // 帧内自检：视频"停在中间且没有在播"超过 5 秒 -> 通知后台接手。
  // 这条比 alarms 心跳（30 秒）快得多，是"卡住能立刻恢复"的关键。
  let stuckSince = 0;
  setInterval(() => {
    if (!S.settings.enabled) return;
    const vs = videos();
    if (!vs.length) { stuckSince = 0; return; }
    const anyPlaying = vs.some(v => !v.paused && !v.ended);
    if (anyPlaying) { stuckSince = 0; return; }
    const pending = vs.some(v =>
      v.paused && !v.ended &&
      v.duration && isFinite(v.duration) && v.duration > 0 &&
      v.currentTime < v.duration - 0.5);
    if (!pending) { stuckSince = 0; return; }
    if (!stuckSince) { stuckSince = Date.now(); return; }
    if (Date.now() - stuckSince > 5000) {
      stuckSince = 0;
      try { chrome.runtime.sendMessage({ type: 'van:stuck', url: location.href }); } catch (_) {}
    }
  }, 1500);

  log('injected', location.href.slice(0, 100));
})();
