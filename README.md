# 视频自动连播 · 自动下一节

浏览器扩展（Manifest V3），用于超星学习通等在线课程平台：

- 当前视频播完后，自动播放下一个视频
- 当前页面 / 当前小节的视频**全部播完**后，自动切到下一小节并开始播放
- 处理超星「当前章节还有任务点未完成」的拦截弹窗（点它的「下一节」）

## 安装

1. Edge 打开 `edge://extensions/`（Chrome 用 `chrome://extensions/`）
2. 打开右上角「开发人员模式」
3. 点「加载解压缩的扩展」，选择本仓库目录
4. 打开课程页，扩展会在所有 frame 自动生效

> 改了代码后，需要在扩展页点一次**刷新**图标才会生效。

## 工作方式

课程页通常是多层 iframe：

```
studentstudy（外层：目录 + 下一节按钮 + 弹窗）
 └ knowledge/cards（任务点容器）
    ├ ananas/modules/video/index.html   ← 视频1
    ├ ananas/modules/video/index.html   ← 视频2
    └ ananas/modules/video/index.html   ← 视频3
```

content script 注入**所有 frame**，每帧只做两件事：

- **汇报事实** `snapshot()`：有几个视频、谁在播、谁播完了、能不能点「下一节」、任务点完成情况、弹窗是否打开
- **执行动作**：播放指定视频 / 点击指定元素 / 点弹窗的「下一节」

**所有决策集中在 background**，避免多帧各自点击造成「连跳两节」。

### 决策优先级

1. 有视频在播 → 什么都不做
2. 超星弹了「任务点未完成」→ 点它自己的「下一节」
3. 有暂停且已加载的视频 → 播放它
4. 还有未完成的**视频**任务点 → 只拉视频，不切小节
5. 有「下一任务点 / 下一节」按钮 → 点它
6. 目录里有下一小节 → 切过去

### 触发时机

- content script 就绪即上报（`van:frameReady`）
- 视频播完上报（`ended` 事件 + 轮询兜底）
- background 看门狗（`tabs.onUpdated` + `chrome.alarms` 心跳）

## 关键设计

### 目录里有两类项，必须区分

```html
<div class="posCatalog_select firstLayer" id="6">6 专题六 ...</div>  <!-- 专题标题，点了只折叠 -->
<div class="posCatalog_select" id="cur1229115478">6.1 课前学习</div>   <!-- 真正的小节 -->
```

真实小节 id 以 `cur` 开头。若把标题行当成「下一节」去点，页面纹丝不动 —— 这是最容易踩的坑。

### 同一小节的多个视频不能互相抢

超星同一小节里的多个 `<video>` 会同时存在。如果 `pausedVideoIndex` 把「已播完」的视频也算作待播，后台会反复 `play()` 它，与正在播的视频互抢，画面表现为**抽搐**。

对应约束：
- `pausedVideoIndex` 只报告「暂停 + 已加载 + 未播完 + 没被标记播过」
- `playIndex()` 拒绝播放已播完的视频，且本帧已有视频在播时不启动第二个
- 接管循环一发现「有视频在播」立即停手，同一视频只尝试一次

### snapshot 必须逐项容错

`executeScript` 会静默吞掉 content script 的异常。曾出现过某个辅助函数缺失导致 `snapshot()` 整体抛 `ReferenceError`，表现就是「扩展装了但完全不动」。现在每项独立 `try/catch`。

## 已知限制

- 选择器按超星 2026 版页面结构校准（`.posCatalog_select` / `#prevNextFocusNext` / `.ans-attach-ct` / `ans-job-finished` / `.maskDiv.jobFinishTip`），平台改版后需更新
- **不设 90% 观看时长门槛**：只保证视频播完即切换（代码里保留覆盖统计，默认关闭）
- 测验、阅读等非视频任务点不阻止切换
- 自动播放受浏览器策略限制，被拦截时降级为静音播放
- 长时间无人值守自动刷课可能触发平台风控（如验证码），请自行斟酌使用

## 测试

测试用独立的无头 Edge 实例（`--load-extension`），不触碰日常浏览器。

```bash
cd test
node verify.mjs      # 两个视频依次播完、无抽搐（核心回归）
node popuptest.mjs   # 「任务点未完成」弹窗：点对「下一节」，不点「去学习」
node cattest.mjs     # 目录跳过专题标题行，正确进入下一小节
node assert.mjs      # 多小节顺序推进
node covtest.mjs     # 视频播完即切，无 90% 门槛
node tabtest.mjs     # 落在「章节测验」标签时切回「视频学习」
```

`test/site/` 下是 mock 课程页，结构按真实超星 DOM 复刻。
