#!/usr/bin/env node
// dshtunnel — 把任意本地服务装进手机（局域网 + 公网隧道 + 8 位 PIN）
// 用法：
//   dshtunnel                         局域网模式（手机同一 WiFi 扫码）
//   dshtunnel --public                公网模式（cloudflared 快速隧道）
//   dshtunnel --mode token --token T --url https://t.example.com --public   自定义公网隧道
//   dshtunnel status                  打印当前状态（JSON）
import os from 'node:os';
import path from 'node:path';
import { createTunnelService } from '../lib/service.js';
import { qrTerminal } from '../lib/qr.js';
import * as settings from '../lib/settings.js';

function parseArgs(argv) {
  const args = {
    target: 'http://127.0.0.1:43210',
    port: Number(process.env.DSHTUNNEL_PORT || 3082),
    host: '0.0.0.0',
    public: false,
    mode: 'quick',
    token: '', name: '', url: '', bin: '',
    lanAuth: null, pin: null, lanPin: null,
    home: path.join(os.homedir(), '.dshtunnel'),
    lanIp: '', noQr: false, json: false, status: false, help: false,
  };
  const take = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i++, take(i));
    if (a === '--target') args.target = next();
    else if (a === '--port') args.port = Number(next()) || 3082;
    else if (a === '--host') args.host = next();
    else if (a === '--public') args.public = true;
    else if (a === '--mode') args.mode = next();
    else if (a === '--token') args.token = next();
    else if (a === '--name') args.name = next();
    else if (a === '--url') args.url = next();
    else if (a === '--bin') args.bin = next();
    else if (a === '--lan-auth') args.lanAuth = next();
    else if (a === '--pin') args.pin = next();
    else if (a === '--lan-pin') args.lanPin = next();
    else if (a === '--home') args.home = path.resolve(next());
    else if (a === '--lan-ip') args.lanIp = next();
    else if (a === '--no-qr') args.noQr = true;
    else if (a === '--json') args.json = true;
    else if (a === 'status') args.status = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log('dshtunnel — 把本地服务装进手机（局域网 + 公网 + 8 位 PIN）');
  console.log('');
  console.log('用法:');
  console.log('  dshtunnel                         局域网模式（手机同一 WiFi）');
  console.log('  dshtunnel --public                公网模式（cloudflared 快速隧道，URL 每次重启换新）');
  console.log('  dshtunnel status                  打印当前状态');
  console.log('');
  console.log('自定义公网隧道（自己配置）:');
  console.log('  --mode quick|token|named|external');
  console.log('  --token <T>        远程管理隧道 token（mode=token）');
  console.log('  --name <N>         本机凭据隧道名（mode=named，凭据在 ~/.cloudflared）');
  console.log('  --url <URL>        公网地址（token/named/external 必填）');
  console.log('  --bin <PATH>       自定义 cloudflared 二进制路径（可选）');
  console.log('');
  console.log('通用:');
  console.log('  --target URL       目标服务（默认 http://127.0.0.1:43210）');
  console.log('  --port N           代理端口（默认 3082）');
  console.log('  --lan-auth on|off  局域网密码开关（默认 on）');
  console.log('  --pin 12345678     公网 PIN（8 位数字；不传则自动轮换）');
  console.log('  --lan-pin 12345678 局域网 PIN（8 位数字）');
  console.log('  --home DIR         配置目录（默认 ~/.dshtunnel）');
  console.log('  --lan-ip IP        手动指定局域网 IP');
  console.log('  --no-qr            不打印终端二维码');
  console.log('  --json             状态以 JSON 输出');
  console.log('');
  console.log('安全: 被暴露的服务能执行代码。公网 = 把服务暴露到互联网，请用强 PIN、用完即关。');
}

function parseTarget(t) {
  const u = new URL(t);
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  return { host: u.hostname, port: Number(port) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  // 应用持久化配置（CLI 参数覆盖）
  const cfg = settings.tunnelConfig(args.home);
  if (args.mode && args.mode !== 'quick') {
    settings.saveTunnelConfig(args.home, { mode: args.mode, token: args.token, name: args.name, publicUrl: args.url, bin: args.bin });
  }
  if (args.lanAuth !== null) settings.setLanAuthEnabled(args.home, args.lanAuth !== 'off');
  if (args.pin) {
    if (!/^\d{8}$/.test(args.pin)) { console.error('❌ --pin 必须是 8 位数字'); process.exit(1); }
    settings.writePin(args.home, 'public', args.pin);
    settings.setPinCustom(args.home, 'public', true);
  }
  if (args.lanPin) {
    if (!/^\d{8}$/.test(args.lanPin)) { console.error('❌ --lan-pin 必须是 8 位数字'); process.exit(1); }
    settings.writePin(args.home, 'lan', args.lanPin);
    settings.setPinCustom(args.home, 'lan', true);
  }

  const upstream = parseTarget(args.target);
  const service = createTunnelService({
    dshPort: upstream.port,
    port: args.port,
    home: args.home,
    onTunnelReady: async () => {
      // 公网隧道就绪 → 轮换公网 PIN（自定义后不轮换）
      const { pinCustom, rotatePublicPin } = await import('../lib/settings.js');
      return rotatePublicPin(args.home, pinCustom(args.home, 'public'));
    },
  });
  await service.startProxy();

  if (args.status) {
    const st = await service.status();
    const s = await import('../lib/settings.js');
    console.log(args.json ? JSON.stringify({
      ...st,
      publicPin: s.getPublicPin(args.home),
      lanPin: s.getLanPin(args.home),
      lanAuthEnabled: s.lanAuthEnabled(args.home),
    }, null, 2) : JSON.stringify({
      ...st,
      publicPin: s.getPublicPin(args.home),
      lanPin: s.getLanPin(args.home),
      lanAuthEnabled: s.lanAuthEnabled(args.home),
    }, null, 2));
    await service.dispose();
    process.exit(0);
  }

  const st = await service.status();
  if (args.json) {
    console.log(JSON.stringify({ mode: 'lan', ...st }, null, 2));
  } else {
    console.log('🚀 dshtunnel 就绪');
    console.log('  目标服务: ' + args.target);
    console.log('  局域网:   ' + (st.lanUrl || '(未检测到局域网 IP)'));
    if (!args.noQr && st.lanUrl) {
      console.log(await qrTerminal(st.lanUrl));
    }
  }

  let tunnel = null;
  if (args.public) {
    console.log('🌐 正在建立公网隧道（' + args.mode + '）…');
    console.log('⚠️  安全提醒: 被暴露的服务能执行代码，公网链接 = 暴露到互联网，请用强 PIN、用完即关');
    try {
      tunnel = await service.startTunnel();
      const st2 = await service.status();
      if (args.json) {
        console.log(JSON.stringify({ mode: 'public', ...st2 }, null, 2));
      } else {
        console.log('  公网:     ' + tunnel);
        if (!args.noQr) console.log(await qrTerminal(tunnel));
      }
    } catch (err) {
      console.error('❌ 公网隧道失败: ' + (err?.message ?? err));
      console.error('   （局域网二维码仍可用；代理保持运行）');
    }
  }

  if (!args.json) console.log('    Ctrl+C 停止（会同时关闭公网隧道）');
  const shutdown = async () => {
    console.log('\n👋 dshtunnel 已退出');
    await service.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('❌ dshtunnel: ' + (err?.message ?? err));
  process.exit(1);
});