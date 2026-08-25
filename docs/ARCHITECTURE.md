# DeepFusion 架构文档

版本：v1.0（M2 里程碑定稿） · 纯 Node.js ESM · Windows/macOS/Linux

## 1. 组件图

```
┌──────────────────────────────────────────────────────────────┐
│                        DeepFusion                           │
│                                                            │
│  ┌─────────────┐   ┌────────────────┐   ┌────────────────┐ │
│  │  CLI        │   │  Web 工作台     │   │  REST API      │ │
│  │  src/index  │   │  src/server.js  │   │  /api/*        │ │
│  └──────┬──────┘   └───────┬────────┘   └───────┬────────┘ │
│         │                  │                    │          │
│         ▼                  ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              编排核心 orchestrator.js                 │  │
│  │   dispatchToReasonix / dispatchAllPending(并发=2)     │  │
│  └───────────┬──────────────────────────┬───────────────┘  │
│              │                          │                  │
│              ▼                          ▼                  │
│  ┌─────────────────────┐   ┌───────────────────────────┐  │
│  │ 队列 core/queue.js   │   │ 并发池 core/dispatcher.js  │  │
│  │ data/tasks/*.json    │   │ runConcurrent/dispatchBatch│  │
│  └──────────┬──────────┘   └───────────┬───────────────┘  │
│             │                          │                  │
│             ▼                          ▼                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │          执行桥 engine/runner.js                     │  │
│  │  spawn reasonix run --events-jsonl（cmd.exe /c 包装） │  │
│  │  → 解析 JSONL：text / usage / run_done                │  │
│  └──────────────────────────┬───────────────────────────┘  │
│                             │                              │
│                             ▼                              │
│                 ┌────────────────────────┐                 │
│                 │   reasonix 子进程       │                 │
│                 │  （前缀缓存优化）       │                 │
│                 └────────────────────────┘                 │
└──────────────────────────────────────────────────────────────┘

辅助组件：
- `engine/manager.js` — reasonix 检测（PATH / npx / 常见位置）+ `data/engine.json` 配置
- `engine/reasonix.js` — ACP v1 客户端（备用通道，未启用为默认路径）
- `src/dsh-bridge/` — DSH 插件挂载示例（cordis.patch.yml）
- `data/ledger.json` — 成本台账（Web API 与 CLI 共用）

## 2. 数据流：任务 JSON → runner → usage → ledger

```
┌──────────┐   ┌────────────────┐   ┌─────────────────┐   ┌───────────────┐
│ 任务 JSON │──▶│ orchestrator   │──▶│ runner.js       │──▶│ reasonix 子进程 │
│ data/tasks│   │ buildTaskPrompt│   │ run --events-   │   │ 前缀缓存优化    │
│ /task-*.  │   │ dispatchToRea- │   │ jsonl 解析      │   │ 执行 → JSONL 事件│
│ .json     │   │ sonix          │   │ text/usage      │   └───────┬───────┘
└─────┬────┘   └───────┬────────┘   └────────┬────────┘           │
      │ pending        │ claim(assigned)     │ events             │
      ▼                ▼                     ▼                    │
┌────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
│ taskStats      │  │ task.costUsage    │  │ 结果回收            │◀─┘
│ overview API   │  │ {inputTokens,     │  │ result + verifyResult│
│                │  │  outputTokens,    │  │ 写回任务 → done     │
└────────────────┘  │  cacheHit/Miss,   │  └─────────┬──────────┘
                    │  durationMs}      │            │
                    └────────┬─────────┘            │
                             │                      │
                             ▼                      ▼
                    ┌─────────────────────────────────────┐
                    │  ledger（server.js recordDispatch）  │
                    │  data/ledger.json                    │
                    │  {taskId,title,usage,durationMs,at}  │
                    └─────────────────────────────────────┘
```

关键细节：
1. **领取**：仅 `status === 'pending'` 的任务会被 `claim` 置为 assigned（owner=reasonix），并发池内不会重复领取。
2. **执行**：`runner.js` 把任务文本拼进 `reasonix run --events-jsonl [--model] <prompt>`，stdout 为 JSONL 事件流。
3. **usage 解析**：`usage` 事件 → `{inputTokens, outputTokens, cacheHitTokens, cacheMissTokens}`，`cacheHitRate` 计算缓存命中率。
4. **回写**：成功 → 任务置 done，`result`（截断 2000 字）+ `verifyResult`（含 cache_hit_rate）+ `costUsage`；失败 → reopen。
5. **台账**：server.js 在派发成功后 `appendLedger`；CLI `deepfusion ledger` 读取打印，无文件则提示。

## 3. 并发模型

- `runConcurrent(items, worker, concurrency=3)`：通用 promise pool，并发上限由 concurrency 控制，单元素失败（抛异常）不阻断其他，返回保持顺序的结果数组。
- `dispatchBatch(taskIds, {concurrency=3})`：并行调用 `dispatchToReasonix`，返回 `{results:[{id, ok, error?, costUsage?}]}`。
- `dispatchAllPending({concurrency=2})`：队列中全部 pending 任务并发派发（默认 2，可调）。
- Web 端 `/api/dispatch/batch` 并发上限 3（server.js BATCH_LIMIT）。

## 4. 决策记录（ADR，v1.0 定稿要点）

### ADR-001：执行路径选 `reasonix run --events-jsonl` 而非 ACP
- **背景**：reasonix 提供 ACP v1 协议与 CLI run 两种通道。
- **决策**：M2 默认走 CLI `run --events-jsonl`（spawn 子进程，`cmd.exe /c` 包装适配 Windows .cmd）。
- **理由**：实现简单、事件流（text/usage/run_done）解析直接、无需常驻进程；ACP 客户端（engine/reasonix.js）保留为备用。
- **代价**：每次派发起新进程，无进程级会话复用；后续可评估 ACP 长连接。

### ADR-002：任务文件采用 dsh-command-center JSON 协议
- **决策**：任务落在 `data/tasks/task-<id>.json`，字段 id/title/context/verify/status/owner/result/verifyResult/costUsage。
- **理由**：与指挥中心共享同一协议，任务可跨窗口认领、状态可被外部工具读取。

### ADR-003：成本信息进任务（costUsage）+ 台账（ledger.json）双写
- **决策**：runner 解析的 usage 先写回任务 `costUsage`，派发成功后由 server 追加台账记录。
- **理由**：任务文件保留单次执行详情，台账提供全量成本视图；纯 JSON 文件、无数据库依赖。

### ADR-004：并发池收敛到 core/dispatcher.js
- **决策**：通用并发控制（runConcurrent）与任务批派（dispatchBatch）收敛为单一模块，orchestrator/server 复用。
- **理由**：避免多处手写 cursor 池（server.js 曾内联实现）；并发上限默认 2（编排）与 3（Web batch）。

### ADR-005：DSH 集成走 cordis patch + HTTP /api 双通道
- **决策**：插件形态提供 cordis.patch 示例注入入口；同时暴露完整 REST /api 供 DSH Agent 直接 curl 调用。
- **理由**：patch 挂载即插即用，HTTP 通道零依赖、便于跨进程集成。

## 5. 待办与风险

- ACP 备用通道未端到端验证（需 reasonix ACP server 实测）。
- npx 检测首次联网较慢（15s 超时），离线环境会误报不可用。
- 任务结果截断 2000 字，超长输出需查 reasonix 原始事件。

## 6. 前端界面架构（v0.4+）

### 6.1 四栏布局

```
┌─────────────────────────────────────────────────────────────────┐
│  顶栏（topbar）：Logo + 路径 + 引擎状态                    38px │
├──────────┬──────────────────────────────────┬───────────────────┤
│ 左侧边栏  │         中间主区                  │  右侧边栏         │
│ (264px)  │     (flex: 1)                    │  (248px)          │
│          │  ┌─────────────────────────────┐  │  上下文环形进度    │
│ 会话管理  │  │ 标签页：💬对话 🕸轨迹 🧠上下文 │  │  会话指标(5项)    │
│ 新建对话  │  ├─────────────────────────────┤  │  用量分析(4类)    │
│ 搜索框   │  │  对话流 / 轨迹 / 上下文内容    │  │  子代理面板       │
│ 会话列表  │  │  (flex: 1, overflow-y: auto) │  │                   │
│          │  ├─────────────────────────────┤  │                   │
│ 账户信息  │  │  底部控制栏                    │  │                   │
│ 设置按钮  │  │  工具按钮 · 6模式 · 模型选择   │  │                   │
│          │  │  输入框 + 发送/停止 + 预估tok  │  │                   │
└──────────┴──────────────────────────────────┴───────────────────┘
```

### 6.2 前端组件树

```
src/web/
├── index.html      — HTML 骨架：四栏布局 + 标签页 + 控制栏
├── style.css       — 深色主题样式（Reasonix 风格移植）
│   ├── 主题 Token  : --bg, --accent, --font, --font-mono
│   ├── 四栏布局    : grid-template-columns: 264px 1fr 248px
│   ├── 顶栏        : 自定义顶栏（替代系统菜单栏）
│   ├── 左侧会话    : 搜索/新建/列表/选中态
│   ├── 消息流      : 用户/助手/错误/思考块/代码块
│   ├── 底部控制栏  : 模式按钮/输入框/发送
│   ├── 右侧监控    : 环形进度/指标/用量/子代理
│   └── 响应式      : ≤1100px 隐藏右侧栏
├── app.js          — 前端逻辑
│   ├── 会话管理    : loadConversations/openConversation
│   ├── SSE 流式对话 : sendChat (fetch + ReadableStream)
│   ├── 消息渲染    : renderMessages/renderAssistantBody
│   │   ├── 代码块  : ```lang → 高亮 + 复制按钮
│   │   ├── 思考块  :  thinking → 折叠面板
│   │   └── 普通文本 : 正文
│   ├── 多代理      : startMultiAgent/pollGoal/loadSubagents
│   ├── 右侧面板    : refreshRightPanel/updateContextRing/updateMetrics
│   ├── 思考轨迹页  : renderTracePanel (goals 时间线)
│   ├── 上下文页    : renderContextPanel (会话信息/消息)
│   └── 错误处理    : 重试按钮 (retryLastChat)
└── manifest.json   — PWA 清单
```

### 6.3 SSE 流式协议

```
POST /api/chat/stream → text/event-stream

event: turn_started   data: {"runId","mode","conversationId"}
event: text           data: {"text":"增量"}          —— 打字机增量
event: phase          data: {"phase":"thinking|acting|streaming"}
event: usage          data: {"usage":{inputTokens,outputTokens,cacheHitTokens,cacheMissTokens}}
event: context        data: {"rawTokens","compressedTokens","ratio","pct","warn"}
event: run_done       data: {"ok","durationMs","text","error"}
```

前端用 `ReadableStream` 逐行解析 SSE，text 事件实时追加到 body 流式渲染，对话结束后调用 `renderAssistantBody` 重新渲染为完整格式（代码块高亮、思考块折叠）。

### 6.4 中文字体兜底规范

```css
--font: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
        "Microsoft YaHei", "微软雅黑", "Noto Sans CJK SC",
        "Source Han Sans SC", sans-serif;
```

优先级：macOS 系统字体 → 苹方 → 冬青黑体 → 微软雅黑 → Noto → 思源 → 默认无衬线。
所有 JSON 读写、HTTP 响应头强制 `charset=utf-8`。

## 7. 决策记录更新（v0.4.1）

### ADR-006：Windows 启动绕过 cmd.exe shim 直接 spawn node + js 入口

- **背景**：v0.3 使用 `cmd.exe /c reasonix.cmd run ...` 启动 reasonix，但 npm 生成的 `.cmd` shim 中的 `endLocal & goto #_undefined_# 2>NUL ||` 技巧在 `cmd /c` 下可能导致 reasonix 未真正执行就退出（退出码 1）。
- **决策**：新增 `resolveWinLaunch()` 函数，在 Windows 上优先解析 npm `.cmd` shim 为 `node + 实际 js 入口`，直接 spawn node.exe，绕过 cmd 的 goto 技巧。
- **解析路径**：`<APPDATA>\npm\reasonix.cmd` → `<APPDATA>\npm\node_modules\reasonix\bin\reasonix.js`
- **回退**：若解析失败，仍用 `cmd.exe /c` 走完整路径兜底。
- **效果**：退出码 1 问题已修复，所有错误分支打印完整 stderr 到控制台。

### ADR-007：前端会话标题从 sanitized 内容提取

- **背景**：引擎返回乱码（U+FFFD 替换符）时，`sanitizeText` 将内容替换为 fallback，但标题仍用原始乱码内容切片，导致会话列表显示乱码或全屏「历史对话」。
- **决策**：`appendMessage` 中标题从 sanitized 后的内容提取（去除替换符），只取前 15 字。
- **效果**：新建会话会自动取用户首条消息前 15 字作为标题，乱码数据在前端刷新后自动修复。