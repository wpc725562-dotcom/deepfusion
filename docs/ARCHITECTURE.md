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