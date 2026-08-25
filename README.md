# DeepFusion 深融

**DSH × Reasonix 融合 Agent 引擎** — 把 DeepSeek Harness 的编排哲学与 Reasonix 的执行引擎融为一个自用智能体应用。

> 📖 [完整身份声明 →](docs/IDENTITY.md) 运行时架构、执行模型、能力栈、工程评估的深度介绍

> "single-column, developer-dense, terminal-flavored" 终端风界面（参考 Reasonix Desktop 风格）

## ✨ 特性

| 能力 | 说明 |
|---|---|
| 🧩 **插件** | 统一目录 ~/.deepfusion/plugins/，声明式插件（plugin.json + skills），兼容 DSH 插件生态 |
| ⚙️ **配置** | ~/.deepfusion/config.toml 分层覆盖（flag > env > 项目 .deepfusion.toml > 全局） |
| 🛠 **CLI** | 一命令族全能力：chat/run/task/plugin/skill/mcp/config/session/ledger/doctor |
| 🔌 **MCP** | Client 管理外部 MCP 服务器（filesystem/github 等） |
| 🎯 **Skill** | ~/.deepfusion/skills/<name>/SKILL.md（DSH 同款格式），对话/任务自动注入 |
| 💬 **AI 对话** | 多轮上下文 + token 成本实时显示 |
| 📋 **任务队列** | pending → assigned → done 状态机 + 并发调度 |
| 💰 **成本台账** | 每次执行的 token 消耗 + 缓存命中率 |
| 🖥 **桌面应用** | Electron 壳：单实例/托盘/内置 server/窗口状态 |
| 📱 **手机访问** | 内置 dshtunnel：局域网扫码 + 公网隧道（可自定义配置）+ 8 位 PIN，手机实时同屏（见 [docs/PHONE-ACCESS.md](docs/PHONE-ACCESS.md)） |
| 🔗 **DSH 桥** | cordis.patch 挂载，复用 DSH 插件生态 |

## 🚀 快速开始

```bash
# 0. 手机访问（可选）：启动后左下角「📱 手机访问」扫码即可；详见 docs/PHONE-ACCESS.md
# 1. 安装 reasonix 引擎（已装则跳过）
npm i -g reasonix

# 2. 启动 Web 工作台（或桌面应用）
npm start                 # Web: http://127.0.0.1:43210
npm run desktop           # Electron 桌面应用

# 3. CLI 直接对话
deepfusion chat "帮我写个排序算法"
```

## 🛠 CLI 命令

```
deepfusion web              启动 Web 工作台
deepfusion chat "问题"      直接对话（reasonix 引擎）
deepfusion run <taskId>     派发任务
deepfusion dispatch         派发全部 pending
deepfusion task add/list    任务队列
deepfusion ledger           成本台账
deepfusion plugin list      插件列表
deepfusion plugin add <git|path>   安装插件
deepfusion plugin doctor    插件健康检查
deepfusion skill list       技能列表
deepfusion skill load <name> 查看技能
deepfusion mcp list          MCP 服务器
deepfusion mcp add <name> <command> [args...]
deepfusion config show      查看生效配置
deepfusion session list     会话列表
deepfusion doctor           系统诊断
```

## ⚙️ 配置（~/.deepfusion/config.toml）

```toml
[engine]
bin = "reasonix"            # 引擎路径
model = "deepseek-chat"     # 默认模型
compactRatio = 0.85         # 缓存感知压缩阈值

[plugins]
enabled = ["hello-deepfusion"]

[mcp]
[[mcp.servers]]
name = "filesystem"
command = "npx.cmd"
args = ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users"]

[skills]
autoInject = true           # 对话自动注入匹配技能

[permission]
mode = "allow"              # allow / ask / deny

[budget]
dailyTokens = 0             # 0 = 不限
currency = "CNY"
```

## 🧩 插件

```bash
deepfusion plugin add https://github.com/user/awesome-plugin   # 从 Git 安装
deepfusion plugin add ./local-plugin-dir                      # 本地安装
deepfusion plugin list                                        # 列表
deepfusion plugin doctor                                      # 健康检查
```

插件结构：

```
~/.deepfusion/plugins/<name>/
├── plugin.json          # {name, version, description, type}
└── skills/<name>/SKILL.md   # 插件自带技能
```

## 🎯 Skill

把 SKILL.md 放进 ~/.deepfusion/skills/<name>/SKILL.md，对话/派发任务时自动按关键词匹配注入。

已预装技能（复用 DSH）：dsh-commander / dsh-worker / web-research / systematic-debugging / verification-before-completion

## 🔌 MCP

```bash
deepfusion mcp add filesystem npx.cmd -y @modelcontextprotocol/server-filesystem C:/Users
deepfusion mcp list
deepfusion mcp remove filesystem
```

## 📁 项目结构

```
deepfusion/
├── electron/            Electron 桌面壳（main.cjs/preload.cjs）
├── src/
│   ├── index.js         CLI 入口
│   ├── server.js        Web 工作台服务（43210）
│   ├── cli/             CLI 子命令（chat/plugin/skill/mcp/doctor/session）
│   ├── core/            核心（config/queue/orchestrator/dispatcher/conversations/skills）
│   ├── engine/          引擎（runner=reasonix 执行桥 / reasonix ACP / manager 检测）
│   ├── dsh-bridge/      DSH 桥接说明
│   └── web/             Reasonix 风格前端
├── docs/                架构文档
└── data/                运行数据（任务/对话/台账，不入库）
```

## 📦 桌面打包

```bash
npm run desktop                 # 开发运行
npx electron-packager . DeepFusion --platform=win32 --arch=x64 --out=dist --overwrite --prune
```

## 📄 License

MIT © DeepFusion Contributors — 融合自 DeepSeek Harness × DeepSeek-Reasonix，均为开源。