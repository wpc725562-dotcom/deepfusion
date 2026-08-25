# dshtunnel

把任意本地服务装进手机：**局域网 + 公网（cloudflared 隧道）+ 8 位 PIN** 扫码访问。

- 局域网：手机连同一 WiFi 扫码即开（密码可选）
- 公网：cloudflared 快速隧道（零配置）或自定义隧道（token / named / external，自己配置）
- 安全：公网永远强制 8 位 PIN + 会话 cookie + 登录限速
- 零框架：纯 Node 标准库 + qrcode

## 安装

```bash
npm i -g dshtunnel
# 或本地
node bin/dshtunnel.mjs
```

## 用法

```bash
dshtunnel                                    # 局域网模式（默认目标 http://127.0.0.1:43210）
dshtunnel --target http://127.0.0.1:8000     # 适配任意服务
dshtunnel --public                           # 公网快速隧道
dshtunnel --public --mode token --token T --url https://df.example.com   # 自定义
dshtunnel status                             # 状态（JSON）
```

## 选项

`--target URL` `--port N` `--public` `--mode quick|token|named|external` `--token T` `--name N` `--url U` `--bin PATH`
`--lan-auth on|off` `--pin 12345678` `--lan-pin 12345678` `--home DIR` `--lan-ip IP` `--no-qr` `--json`

## 测试

```bash
npm test
```

## 许可

MIT — 与 DeepFusion 一致。
