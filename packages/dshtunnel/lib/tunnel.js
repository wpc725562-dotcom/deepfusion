// tunnel.js — 公网隧道：cloudflared 快速隧道 + 自定义隧道（自己配置）
// 快速隧道：https://<随机子域>.trycloudflare.com，URL 每次重启换新
// 自定义隧道：token（远程管理）/ named（本地凭据）/ external（外部已建隧道）
import { spawn, execSync } from 'node:child_process';
import { mkdir, access, stat, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// 排除保留子域 api（cloudflared 输出会先出现 https://api.trycloudflare.com 注册地址）
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

function platformBinary() {
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const a = archMap[process.arch] ?? process.arch;
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return { os, a, ext: os === 'windows' ? '.exe' : '' };
}

// 下载源：官方 GitHub + 国内加速源（按序回退）
const CLOUDFLARED_MIRRORS = [
  (asset) => 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset,
  (asset) => 'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset,
  (asset) => 'https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset,
  (asset) => 'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset,
];

function cloudflaredOnPath() {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** 单流下载一个文件到 dest；失败抛错。 */
async function downloadFile(url, dest, signal) {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** 拿一个可用的 cloudflared 路径：PATH → 缓存 → 下载。 */
export async function resolveCloudflared({ home, onPhase = () => {}, signal } = {}) {
  if (cloudflaredOnPath()) return 'cloudflared';
  const dshHome = home ?? process.env.DEEPFUSION_HOME ?? join(process.env.HOME || process.env.USERPROFILE || '', '.deepfusion');
  const cacheDir = join(dshHome, 'dshtunnel', 'bin');
  const { os, a, ext } = platformBinary();
  const candidates = [
    join(cacheDir, 'cloudflared' + ext),
    join(cacheDir, 'cloudflared-' + os + '-' + a + ext),
  ];
  for (const bin of candidates) {
    try { await access(bin); return bin; } catch { /* 下一个 */ }
  }
  onPhase('downloading');
  await mkdir(cacheDir, { recursive: true });
  const asset = os === 'windows' ? 'cloudflared-windows-' + a + '.exe' : 'cloudflared-' + os + '-' + a + '.tgz';
  const tmpFile = join(cacheDir, 'cloudflared.download');
  const target = join(cacheDir, 'cloudflared' + ext);
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  let lastErr = null;
  for (let i = 0; i < CLOUDFLARED_MIRRORS.length; i++) {
    const url = CLOUDFLARED_MIRRORS[i](asset);
    try {
      await downloadFile(url, tmpFile, fetchSignal);
      const st = await stat(tmpFile);
      if (st.size < 1024 * 1024) throw new Error('文件异常小（' + st.size + ' 字节），疑似镜像错误页');
      if (os === 'windows') {
        await rename(tmpFile, target).catch(async () => {
          const { cp } = await import('node:fs/promises');
          await cp(tmpFile, target).catch(() => {});
        });
      } else {
        // tgz 解压（GitHub 资产为 tar.gz，内含 cloudflared 二进制）
        const extractDir = join(cacheDir, '.extract-' + process.pid);
        await mkdir(extractDir, { recursive: true });
        try {
          await new Promise((resolve, reject) => {
            const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
            child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('解压失败 code=' + code)));
            child.once('error', reject);
          });
          const binFile = join(extractDir, 'cloudflared' + ext);
          await rename(binFile, target).catch(async () => {
            const { cp } = await import('node:fs/promises');
            await cp(binFile, target).catch(() => {});
          });
        } finally {
          await rm(extractDir, { recursive: true, force: true }).catch(() => {});
        }
        const { chmod } = await import('node:fs/promises');
        await chmod(target, 0o755).catch(() => {});
      }
      await rm(tmpFile, { force: true }).catch(() => {});
      lastErr = null;
      return target;
    } catch (err) {
      lastErr = err;
      await rm(tmpFile, { force: true }).catch(() => {});
    }
  }
  throw new Error('cloudflared 下载失败：所有镜像源不可用（最后错误：' + (lastErr?.message ?? lastErr) + '）。Windows 可手动 winget install cloudflared 或把二进制放到 ' + cacheDir);
}

/**
 * 启动 cloudflared 快速隧道。
 * @returns {Promise<{url, kill, onExit}>}
 */
export async function startQuickTunnel({ port, home, signal, onPhase = () => {} }) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  // HTTP/2（TCP 443）而非默认 QUIC（UDP 7844）：国内网络常屏蔽 UDP 7844（error 1033）
  const child = spawn(bin, ['tunnel', '--url', 'http://127.0.0.1:' + port, '--protocol', 'http2', '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (err) => {
    cleanup?.();
    rejectErr?.(new Error('cloudflared 启动失败：' + (err?.message ?? err) + '（可删除 <home>/dshtunnel/bin 缓存后重试）'));
  });
  onPhase('registering');

  let cleanup = null;
  let rejectErr = null;
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup();
        onPhase('ready');
        resolve(m[0]);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error('cloudflared 退出（code=' + code + '）'));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error('cloudflared 启动超时（30s）——请检查代理/VPN（Clash 等 TUN 模式会掐断隧道），退出代理后重试 | timeout — quit proxy/VPN (Clash TUN) and retry'));
    }, 30_000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  const exitListeners = new Set();
  child.on('exit', (code) => { for (const cb of exitListeners) cb(code); });
  return {
    url,
    kill: () => { try { child.kill(); } catch {} },
    onExit: (cb) => { exitListeners.add(cb); return () => exitListeners.delete(cb); },
  };
}

/**
 * 启动自定义隧道（自己配置）：
 *  - token：cloudflared tunnel run --token <token>（Cloudflare 远程管理隧道）
 *  - named：cloudflared tunnel run <name>（本机 ~/.cloudflared 凭据）
 *  - external：不拉起进程，直接使用已配置的 publicUrl
 */
export async function startCustomTunnel({ config, port, home, signal, onPhase = () => {} }) {
  const mode = config?.mode || 'quick';
  const publicUrl = String(config?.publicUrl || '').trim();
  if (mode === 'external') {
    if (!publicUrl) throw new Error('external 模式必须配置公网地址 publicUrl');
    onPhase('ready');
    return { url: publicUrl, external: true, kill: () => {}, onExit: () => () => {} };
  }
  if (mode !== 'token' && mode !== 'named') throw new Error('不支持的自定义模式: ' + mode);
  if (!publicUrl) throw new Error('token/named 模式必须配置公网地址 publicUrl');

  const bin = config?.bin || await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  const args = mode === 'token'
    ? ['tunnel', 'run', '--token', String(config.token || '').trim()]
    : ['tunnel', 'run', String(config.name || '').trim()];
  if (!args[args.length - 1]) throw new Error('缺少 ' + (mode === 'token' ? 'token' : 'name'));
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  child.on('error', (err) => { try { onPhase('error'); } catch {} });
  // 自定义隧道 URL 由配置给出；子进程存活即视为已注册
  onPhase('registering');
  const timer = setTimeout(() => { onPhase('ready'); }, 1500);
  const exitListeners = new Set();
  child.on('exit', (code) => {
    clearTimeout(timer);
    try { onPhase(code === 0 ? 'idle' : 'error'); } catch {}
    for (const cb of exitListeners) cb(code);
  });
  return {
    url: publicUrl,
    kill: () => { try { child.kill(); } catch {} },
    onExit: (cb) => { exitListeners.add(cb); return () => exitListeners.delete(cb); },
  };
}
