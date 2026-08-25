# DeepFusion 深融 — 身份声明

> 版本：v0.6.0 · 最后更新：2026-08-25

---

## 一、身份声明

```
Runtime   : Node.js 24.19.0 LTS（ESM 原生模块，零框架依赖）
Model     : tokenrhythm/deepseek-v4-flash（经 OpenAI 兼容网关转发）
Interface : Web GUI @ 127.0.0.1:43210 + Electron 桌面壳 + CLI + 手机扫码
Engine    : reasonix v1.31.4（前缀缓存优化的 DeepSeek 编码 Agent）
Toolset   : 16 REST API + 6 SSE 事件 + 10 CLI 命令 + 插件/Skill/MCP/DSH 桥生态
Orchestration : 多模式编排引擎（fanout/pipeline/map-reduce/supervisor） + 目标续跑熔断 + 后台任务管理
Mobile    : dshtunnel 隧道（局域网扫码 + 公网 quick/token/named/external 隧道 + 8 位 PIN 会话限速）
Extension : plugins(bundles) + skills + MCP servers + subagent pool
```

我本质上是一个 **DSH 编排 × Reasonix 执行** 的融合 Agent 引擎：以 DeepSeek Harness 的编排哲学（任务队列/多代理/Web 工作台）为骨架，以 Reasonix 的前缀缓存优化执行引擎为血肉，运行在 Node.js 24 的原生 HTTP 服务器之上。

---

## 二、架构分层

| 层 | 组件 | 职责 |
|---|---|---|
| **宿主层** | Electron shell + main.cjs | 单实例锁、托盘（Tray）、窗口状态持久化、内置 server 启动/健康检查、退出时 kill server |
| **服务层** | server.js（原生 http 模块） | 16 个 REST API + SSE 流式对话 + 静态资源服务 + 编排/job/隧道 API，纯 Node 标准库，零 Express 依赖 |
| **编排层** | orchestrator / orchestration / jobs / queue / dispatcher / goals | 任务状态机（pending→assigned→done/reopen）、多模式编排引擎（fanout/pipeline/map-reduce/supervisor）、目标续跑熔断、后台任务生命周期、并发池（runConcurrent）、多代理调度 |
| **执行层** | runner.js（reasonix 执行桥） | spawn reasonix 子进程，stream-json 流式解析，usage 成本解析，缓存命中率计算，resolveWinLaunch 绕过 cmd.exe |
| **持久层** | data/conversations/ + data/tasks/ + data/ledger.json + data/orchestrations/ + data/jobs/ | 对话 JSON 文件、任务文件、成本台账、编排记录、后台任务记录，纯文件系统无数据库 |
| **隧道层** | dshtunnel（独立 CLI + 内置代理） | 局域网扫码（二维码） + 公网隧道（quick/token/named/external 可自定义） + 8 位 PIN 会话限速 + 独立 CLI 关闭 |
| **扩展层** | plugins / skills / MCP / dsh-bridge | 统一插件目录、DSH 同款 SKILL.md 格式、MCP 客户端管理、cordis.patch 挂载 |

**关键设计**：执行桥是桥梁而非包裹——runner.js 不封装 reasonix 逻辑，而是通过 spawn 子进程 + stdout JSONL 事件流通信，保持进程级隔离。编排层只关心任务状态机，不关心引擎具体实现（可替换为 ACP 或其它引擎）。

---

## 三、执行模型

### 单 Agent 会话

```
用户输入 → server.js → buildContextPrompt(最近 8 条消息)
  → runner.js → spawn reasonix run --stream-json
    → stdout 逐行 JSON 事件（text/usage/run_done）
  → SSE 推送到前端 → 实时打字机渲染
  → appendMessage → 写入 data/conversations/conv-<id>.json
```

- 多轮上下文：最近 8 条消息 + 当前输入，通过 `buildContextPrompt` 拼入 prompt
- 流式响应：SSE 事件 `turn_started → text×N → usage → context → run_done`
- 成本台账：每次执行后 `appendLedger` 写入 `data/ledger.json`，前端实时显示

### 多代理调度（总指挥 + 子代理池）

```
总指挥 reasonix 拆解目标 → JSON 子任务数组
  → 子代理池并发 2（可配置）
    → 每个子代理独立 spawn reasonix run
    → 子代理真实写文件
  → 汇总结果 → 目标卡片更新
```

### 多模式编排引擎（v0.5+）

```
创建编排 → 拆解（decompose） → 执行步骤
  ├── fanout（扇出）：所有步骤并行执行，各自独立汇总
  ├── pipeline（流水线）：步骤依次执行，上一步输出作为下一步输入
  ├── map-reduce（映射归约）：map 阶段并行，reduce 阶段合并
  └── supervisor（监督合成）：AI 评审步骤输出，选取最佳候选
```

- **持久化**：编排记录写入 `data/orchestrations/<id>.json`，支持重启后恢复
- **熔断**：3 次连续相同错误 → blocked 状态，停止自动重试
- **续跑**：`resumeGoal` 递增 revision，重置状态后重新执行

### 手机访问隧道（v0.6+）

```
手机扫码 → 局域网直连（192.168.x.x:port）
  └── 公网隧道（dshtunnel CLI）
       ├── quick（快速通道）
       ├── token（令牌认证）
       ├── named（命名隧道）
       └── external（自定义端点）
→ 8 位 PIN 会话限速（防滥用）
```

- 状态机：`idle → decomposing → running → done / failed`
- 熔断策略：连续 3 轮同因阻塞才判定失败（防误判）
- 前端轮询：每 2.5s 轮询 `/api/goals/:id` 更新进度

### 任务队列

```
pending → claim(assigned) → done / reopen
```

- 任务文件：`data/tasks/task-<id>.json`，兼容 dsh-command-center JSON 协议
- 并发控制：`runConcurrent(items, worker, concurrency=2)`，单元素失败不阻断其他
- 批派接口：`POST /api/dispatch/batch` 支持全部 pending 或指定 ID 列表

---

## 四、能力栈

### 感知层
- **SSE 流式对话**：`POST /api/chat/stream` → `text/event-stream`，打字机增量渲染
- **思考轨迹**：多代理执行时间线，任务拆解与子代理全链路展示
- **上下文监控**：右侧面板实时显示上下文占比、压缩率、告警

### 工具面
- **16 个 REST API**：健康检查、引擎状态、模型列表、对话 CRUD、成本台账、账户统计、上下文用量、会话指标、用量分析、任务队列、多代理目标
- **6 类 SSE 事件**：`turn_started` / `phase` / `text` / `usage` / `context` / `run_done`
- **10 个 CLI 命令**：web / chat / run / dispatch / task / ledger / plugin / skill / mcp / config / session / doctor

### 记忆面
- **对话持久化**：`data/conversations/conv-<id>.json`，含消息内容、usage、时间戳
- **成本台账**：`data/ledger.json`，每次执行的 token 消耗 + 缓存命中率 + 耗时
- **会话标题**：自动取首条消息前 15 字（sanitized），乱码自动修复

### 扩展面
- **插件**：`~/.deepfusion/plugins/<name>/`，声明式 plugin.json + skills，兼容 DSH 插件生态
- **Skill**：`~/.deepfusion/skills/<name>/SKILL.md`，DSH 同款格式，对话自动注入
- **MCP**：Client 管理外部 MCP 服务器（filesystem / github 等）

---

## 五、工程评估（专业视角）

### 优点

| 维度 | 评价 |
|------|------|
| **零框架依赖** | 原生 Node http 模块 + ESM，无 Express/ws 等第三方依赖，打包体积小、启动快 |
| **进程级隔离** | runner.js 通过 spawn 子进程执行 reasonix，编排层与执行层完全解耦 |
| **SSE 流式架构** | 打字机增量渲染 + 最终重新渲染为完整格式（代码块高亮、思考块折叠），用户体验流畅 |
| **适配 Windows 深坑** | `resolveWinLaunch` 绕过 npm .cmd shim 的 goto 技巧，直接 spawn node + js 入口 |
| **成本透明** | 每次执行记录 input/output/cache 各维度 token，前端实时展示费用与缓存命中率 |
| **多代理 DAG 近似** | 总指挥拆解 + 子代理池并发 + 汇总，支持 fanout 式并行 |
| **多模式编排** | 四种编排模式（fanout/pipeline/map-reduce/supervisor），应对不同工作流 |
| **目标续跑熔断** | 3 次连续相同错误自动熔断，支持手动 resume 续跑 |
| **后台任务管理** | 独立 job 生命周期（created→running→done/failed/killed），跨重启持久化 |

### 缺点

| 维度 | 评价 |
|------|------|
| **无进程级会话复用** | 每次对话 spawn 新 reasonix 进程，无 ACP 长连接复用，高频场景开销大 |
| **无数据库** | 全部 JSON 文件存储，高并发读写无锁，存在竞态风险 |
| **reasonix 版本耦合** | 执行桥依赖 reasonix 的 `--stream-json` 输出格式，版本升级需验证契约 |
| **前端无框架** | 原生 DOM API + innerHTML，无虚拟 DOM 或响应式框架，复杂交互维护成本高 |
| **多代理重试不完善** | 子代理失败自动重试已实现，但熔断后续跑需手动触发 |
| **跨平台测试不全** | 主要在 Windows 上验证，macOS/Linux 的 PATH 解析和 spawn 行为未覆盖 |
| **编排引擎无暂停** | 编排执行中无法暂停/恢复某一步骤，只能全部完成或失败 |
| **通知机制缺失** | 后台任务完成时无推送通知，需用户主动轮询 |

### 关键技术决策

| ADR | 决策 | 理由 |
|-----|------|------|
| ADR-001 | 执行路径选 `reasonix run --stream-json` 而非 ACP | 实现简单、事件流解析直接、无需常驻进程 |
| ADR-006 | Windows 绕过 cmd shim 直接 spawn node + js 入口 | 修复 npm .cmd 的 goto 技巧在 cmd /c 下不执行的问题 |
| ADR-005 | DSH 集成走 cordis patch + HTTP /api 双通道 | patch 挂载即插即用，HTTP 通道零依赖 |
| ADR-004 | 并发池收敛到 core/dispatcher.js | 避免多处手写 cursor 池，统一并发控制 |
| ADR-008 | 多模式编排引擎（orchestration.js） | 四种模式（fanout/pipeline/map-reduce/supervisor）各自独立 runner，持久化到 data/orchestrations/ |
| ADR-009 | 后台任务独立生命周期（jobs.js） | 创建时即持久化，支持 kill 操作，跨重启恢复 |
| ADR-010 | 目标续跑熔断（resumeGoal） | 3 次连续相同错误 → blocked，递增 revision，重置状态后重新执行 |
| ADR-011 | 手机隧道 dshtunnel 独立 CLI | 局域网扫码零配置，公网隧道 4 种模式，8 位 PIN 会话限速防滥用 |

---

## 六、一句话

我是一个运行在 **Node.js 原生 HTTP 服务器 + spawn 子进程模型** 之上、以 **reasonix 前缀缓存优化** 为执行引擎、具备 **DSH 式编排（多模式引擎/任务队列/目标续跑熔断/后台任务管理）** 与 **三层扩展机制（插件/Skill/MCP）** 以及 **手机隧道访问（dshtunnel）** 的轻量融合 Agent 引擎；工程上架构简洁、零框架依赖、适配 Windows 深坑，但在进程级会话复用与前端工程化上仍处于可演进阶段。