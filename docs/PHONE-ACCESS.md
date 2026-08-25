# 📱 手机访问（dshtunnel）

把 DeepFusion 工作台装进手机：**局域网扫码直连 + 公网隧道（可自定义配置）+ 8 位访问密码**，手机看到的界面与电脑实时同步（HTTP/SSE 透传，WebSocket 亦支持）。

## 架构

```
手机(任意网络) ──HTTPS──> trycloudflare.com / 你的自定义域名
                                  │  cloudflared 隧道
手机(同一 WiFi) ──HTTP──> 192.168.x.x:3082
                                  │
                    ┌─────────────▼──────────────┐
                    │  dshtunnel 改头反向代理       │
                    │  Host/Origin → 127.0.0.1     │
                    │  公网必验 8 位 PIN；局域网可选  │
                    │  HTTP + SSE + WebSocket 透传  │
                    └─────────────┬──────────────┘
                                  ▼
                    DeepFusion 工作台 127.0.0.1:43210
```

## 快速开始

### 方式一：DeepFusion 设置面板（内嵌）

1. 启动 DeepFusion（`npm run web` 或桌面端）
2. 左下角点击 **📱 手机访问** 按钮
3. 手机连同一 WiFi 扫码局域网二维码即可；点「开启公网访问」获得公网二维码

### 方式二：CLI

```bash
# 局域网模式（手机同一 WiFi 扫码）
node packages/dshtunnel/bin/dshtunnel.mjs

# 公网模式（cloudflared 快速隧道）
node packages/dshtunnel/bin/dshtunnel.mjs --public

# DeepFusion 子命令
node src/index.js tunnel start --public
node src/index.js tunnel status
```

## 公网隧道：快速 vs 自定义（自己配置）

| 模式 | 说明 | 公网地址来源 |
|:---|:---|:---|
| `quick`（默认） | cloudflared 快速隧道，零配置，URL 每次重启换新 | 进程输出自动解析 |
| `token` | Cloudflare 远程管理隧道（用你自己的账号 token） | 配置 `publicUrl` |
| `named` | 本机凭据隧道（`~/.cloudflared` + `cloudflared tunnel login` 过） | 配置 `publicUrl` |
| `external` | 你已用其他方式建好隧道（ngrok / 自有域名等），只登记地址 | 配置 `publicUrl` |

### 自定义配置示例

设置面板里选模式后填写，或 CLI：

```bash
# token 模式（远程管理隧道）
dshtunnel --public --mode token --token eyJh... --url https://df.your-domain.com

# named 模式（本机凭据）
dshtunnel --public --mode named --name my-tunnel --url https://df.your-domain.com

# external 模式（外部已建好隧道）
dshtunnel --public --mode external --url https://df.your-domain.com
```

对应 cloudflared 原生命令：

```bash
cloudflared tunnel run --token <TOKEN>            # token 模式
cloudflared tunnel run <NAME>                     # named 模式（凭据在 ~/.cloudflared）
```

## 访问密码（PIN）

- 公网：**永远强制** 8 位数字 PIN；默认每次开启公网自动轮换（旧链接作废），自定义后固定
- 局域网：可开关（设置面板「访问密码」），默认开
- 会话保持：验证通过后写 `dfp_auth` cookie（HMAC 签名，HttpOnly/SameSite=Lax，30 天）；电脑端重启后需重新输入
- 限速：同 IP 错 5 次锁 60 秒；全局熔断兜底

## 配置目录

```
~/.deepfusion/dshtunnel/
├── settings.json        开关与自定义标记
├── token                公网 PIN（明文，0600）
├── token-lan            局域网 PIN
├── tunnel-config.json   自定义隧道配置（mode/token/name/publicUrl/bin）
├── tunnel-auto.json     公网「开启中」标记（重启自动恢复）
└── bin/cloudflared[.exe] 首次使用自动下载缓存
```

独立 CLI 使用 `~/.dshtunnel/`（`--home` 可改）。

## API（仅 loopback）

| 端点 | 说明 |
|:---|:---|
| `GET  /api/pocket/status` | 状态 + 二维码 + PIN + 隧道配置 |
| `POST /api/pocket/lan/auth` | 局域网密码开关 `{on}` |
| `POST /api/pocket/lan/pin/refresh` | 刷新局域网 PIN |
| `POST /api/pocket/lan/ip` | 手动指定局域网 IP `{ip}` |
| `POST /api/pocket/pin/custom` | 自定义公网/局域网 PIN `{which, value}` |
| `POST /api/pocket/tunnel/start` | 开启公网（需 `{disclaimer:true}`） |
| `POST /api/pocket/tunnel/stop` | 关闭公网（代理保持） |
| `GET/POST /api/pocket/tunnel/config` | 读写隧道配置 |

## 安全注意事项

1. DeepFusion 能执行本机代码——**公网 = 把代码执行控制台暴露到互联网**，请用强 PIN、用完即关
2. 开启公网前必须勾选免责声明（服务端校验 `disclaimer:true`）
3. 局域网密码默认开启；公司/公共 WiFi 建议保持开启
4. 二维码/公网 URL 请勿外传：无密码时 URL 即钥匙（局域网免密模式下）
5. 敏感环境不要用免费 trycloudflare 隧道（流量经 Cloudflare 边缘）

## 常见问题

- **隧道启动超时（30s）**：多为 Clash/VPN TUN 模式掐断隧道，退出代理后重试；已强制 `--protocol http2`（UDP 7844 常被墙）
- **下载 cloudflared 慢**：内置 GitHub + 国内加速源自动回退，首次约 50MB，之后缓存
- **端口 3082 被占**：代理自动 +1 尝试；可用 `DEEPFUSION_POCKET_PORT` 指定
- **扫码打不开**：确认手机与电脑同一 WiFi、防火墙放行 3082/TCP；公网地址每次重启会换新，请重新扫码
