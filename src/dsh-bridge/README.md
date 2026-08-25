# DeepFusion × DSH 桥接

DeepFusion 可以以两种方式融入 DSH（DeepSeek Harness）体系：
作为 **DSH 插件**（通过 cordis patch 挂载），或作为 **独立 HTTP 服务** 被 DSH 调用（MCP/HTTP 集成）。

## 方式一：作为 DSH 插件挂载（cordis.patch.yml）

DSH 的 profile 目录（如 `$DSH_HOME/profiles/<name>/`）下有一个 `cordis.patch.yml`，
它是用户的 patch 层，以 **`- insert:` 条目** 向 DSH 的组合（composition）中注入能力。

把 DeepFusion 的启动入口注入 DSH 后，DSH 会话（Agent）就能：
- 通过 shell 调用 `deepfusion` CLI（web / task / dispatch / run / ledger）；
- 通过 HTTP 调用 DeepFusion 的 `/api` 完成任务派发与查询。

参考示例见同目录 `cordis.patch.example.yml`。

### 挂载步骤

1. 安装 DeepFusion（或把项目目录加入 PATH）：
   ```bash
   npm i -g deepfusion   # 或 npm link（项目内）
   ```
2. 把 `cordis.patch.example.yml` 中的 patch 合并进目标 profile 的 `cordis.patch.yml`；
3. 重启 DSH（`dsh web` / 对应 profile）；
4. DSH 会话即可访问 DeepFusion 工作台入口与 CLI。

## 方式二：通过 HTTP / MCP 集成

DeepFusion 本身就是纯 Node HTTP 服务（`src/server.js`，端口 43210，可用
`DEEPFUSION_PORT` 覆盖）。DSH 侧 Agent 无需插件，直接调 `/api` 即可：

| 端点 | 用途 |
|---|---|
| `GET  /api/overview` | 引擎状态 + 任务统计 + 任务列表 |
| `GET  /api/ledger` | 成本台账 |
| `POST /api/tasks` | 创建任务 |
| `POST /api/tasks/:id/action` | claim / done / reopen / pause / archive |
| `POST /api/tasks/:id/dispatch` | 派发单个任务（返回 costUsage） |
| `POST /api/dispatch/batch` | 并行派发 `{taskIds:[...]}` 或 `{all:true}`（并发上限 3） |
| `POST /api/dispatch` | 派发全部 pending |
| `GET  /api/health` | 健康检查 |

示例（DSH Agent 的 shell 内）：

```bash
curl -s http://127.0.0.1:43210/api/health
curl -s -X POST http://127.0.0.1:43210/api/dispatch/batch \
  -H 'Content-Type: application/json' \
  -d '{"all":true}'
```

未来可进一步封装为 DSH 的动态 Tool（`cordis_define` + `code.host` 里用 fetch 调
`/api`），让 Agent 直接获得 `deepfusion_dispatch` 这类结构化工具调用能力。
