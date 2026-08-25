# DeepFusion · 深融

**DSH × Reasonix 融合 Agent 引擎** —— 把两个开源框架合二为一：
DSH（DeepSeek Harness）式编排哲学 + Reasonix（DeepSeek-Reasonix）式编码执行。

## 产品定位

DeepFusion 是一个**纯 Node.js（ESM）** 的融合 Agent 引擎：

- **编排层来自 DSH**：任务队列（JSON 协议）、多 Agent 并行、Web 工作台、成本台账。
- **执行层来自 Reasonix**：DeepSeek 原生编码引擎，`run --events-jsonl` 模式，
  自带**前缀缓存优化**（省 token），执行结果含 usage 成本信息。
- **融合点**：`src/core/orchestrator.js`（派发/回收状态机）+ `src/engine/runner.js`（Reasonix 执行桥）。

## 架构图

```
┌────────────────────────────────────────────────────┐
│              DeepFusion Web 工作台 (:43210)          │  ← 任务/引擎/台账 一站式
├────────────────────────────────────────────────────┤
│                编排核心 (Node.js ESM)                 │
│  ┌──────────┐   ┌──────────────────┐   ┌─────────┐ │
│  │ 任务队列  │──▶│  dispatcher.js    │──▶│runner.js│ │
│  │(JSON协议) │   │ 并发池 (默认2~3)  │   │reasonix│ │
│  └──────────┘   └──────────────────┘   └─────────┘ │
│        │                  │                │        │
│        ▼                  ▼                ▼        │
│  data/tasks/*.json   costUsage 写入    data/ledger  │
├────────────────────────────────────────────────────┤
│         DSH 桥（可选）：cordis.patch.yml 插件挂载     │
└────────────────────────────────────────────────────┘
```

## 快速开始

```bash
# 1. 安装 reasonix 引擎（编码执行层，DeepSeek 原生）
npm i -g reasonix
reasonix setup          # 配置 DeepSeek API key

# 2. 安装并启动 DeepFusion 工作台
npm i -g deepfusion     # 或在本项目目录 npm link
deepfusion web          # → http://127.0.0.1:43210

# 3. 常用操作
deepfusion engine               # 查看引擎状态
deepfusion task add "写一个排序算法" "用 JS 实现快排"
deepfusion dispatch             # 派发全部 pending（默认并发 2）
deepfusion ledger               # 查看成本台账
```

> 开发模式：`npm start`（= `node src/index.js web`）或 `npm run web`。

## CLI 命令表

| 命令 | 说明 |
|---|---|
| `deepfusion web` | 启动 Web 工作台（http://127.0.0.1:43210） |
| `deepfusion engine` | 查看 reasonix 引擎检测/可用状态 |
| `deepfusion task add <标题> [上下文...]` | 创建任务 |
| `deepfusion task list` | 列出全部任务（含 stalled 标记） |
| `deepfusion run <taskId>` | 派发单个任务给 reasonix |
| `deepfusion dispatch` | 派发全部 pending 任务（默认并发 2，可传 concurrency 选项） |
| `deepfusion ledger` | 打印 `data/ledger.json` 成本台账（无则提示） |
| `deepfusion detect` | 输出引擎检测详情 JSON |

## 目录结构

```
deepfusion/
├── src/
│   ├── index.js            # CLI 入口（web/engine/task/run/dispatch/ledger/detect）
│   ├── server.js           # Web 工作台 + REST API（含 /api/dispatch/batch）
│   ├── core/
│   │   ├── queue.js        # 任务队列（兼容 dsh-command-center JSON 协议）
│   │   ├── orchestrator.js # 融合编排器：派发/回收/并发批派
│   │   └── dispatcher.js   # 并发控制：runConcurrent / dispatchBatch
│   ├── engine/
│   │   ├── runner.js       # reasonix run --events-jsonl 执行桥（usage 解析）
│   │   ├── reasonix.js     # ACP v1 客户端（备用通道）
│   │   └── manager.js      # 引擎检测/配置/状态
│   ├── dsh-bridge/         # DSH 插件挂载示例（cordis.patch）
│   └── web/                # 工作台前端静态资源
├── docs/
│   └── ARCHITECTURE.md     # 组件图 + 数据流 + 决策记录
├── data/                   # 运行时数据（tasks/、ledger.json、engine.json）
└── logs/                   # 运行日志
```

## M2 功能清单（当前里程碑）

- [x] 任务队列：创建/列表/claim/done/reopen/pause/archive，stalled 超时检测
- [x] 引擎管理：reasonix 检测（PATH / npx / 常见安装位置）、配置持久化
- [x] 单任务派发：`dispatchToReasonix`，执行结果 + usage 写回任务 `costUsage`
- [x] 并发派发：`runConcurrent` promise pool、`dispatchBatch`、`dispatchAllPending(concurrency=2)`
- [x] REST API：overview / engine / ledger / tasks / dispatch / dispatch/batch / health
- [x] 成本台账：派发成功后追加 `data/ledger.json`，CLI `deepfusion ledger` 可查
- [x] Web 工作台：任务、引擎状态、成本展示
- [x] DSH 桥：cordis.patch 示例 + /api 集成说明
- [ ] ACP 备用通道端到端验证（src/engine/reasonix.js）
- [ ] MCP Server 封装（供外部客户端直接调用 /api）

## 常见问题

### Q1：Windows 下 reasonix 不是内部或外部命令 / .cmd 无法 spawn

Windows 的全局 npm 包是 `.cmd` 批处理，直接 `spawn('reasonix')` 会报 EINVAL。
DeepFusion 的 `runner.js` 已处理：非 .exe/.com 一律走 `cmd.exe /c` 包装
（`windowsHide: true`），无需额外配置。若仍失败，请确认 `reasonix` 在 PATH 中：
`where reasonix`。

### Q2：如何配置 DeepSeek API key？

`reasonix setup` 会引导写入配置。DeepFusion 侧支持环境变量：

```bash
set DEEPSEEK_API_KEY=sk-xxx     # Windows CMD
$env:DEEPSEEK_API_KEY="sk-xxx"  # PowerShell
export DEEPSEEK_API_KEY=sk-xxx  # bash/Git Bash
```

引擎配置（模型选择等）写在 `data/engine.json`，也可用 `REASONIX_MODEL` 环境变量
覆盖默认模型 `deepseek-pro`。

### Q3：`deepfusion dispatch` 报 reasonix 引擎不可用？

先 `deepfusion engine` 看检测结果：确认已 `npm i -g reasonix` 且 `reasonix --version`
能跑通；配置过 `reasonix setup`。npx 路径检测需要联网拉包，第一次可能较慢（15s 超时）。

### Q4：任务派发成功但 `deepfusion ledger` 说台账不存在？

台账在**启动 CLI 的当前工作目录**的 `data/ledger.json` 下。请确保与启动 Web 工作台
（`deepfusion web`）时的工作目录一致；派发成功后才会写入台账。

### Q5：并发派发会不会重复领取同一任务？

`dispatchToReasonix` 领取时校验 `status === 'pending'` 才置为 assigned，
并发池中同一任务不会重复执行。

## 许可

MIT License
