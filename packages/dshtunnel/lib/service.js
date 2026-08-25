// service.js — 手机访问服务：代理生命周期 + 公网隧道 + 状态快照（含二维码）
import { networkInterfaces } from 'node:os';
import { URL } from 'node:url';
import { createPocketProxy } from './proxy.js';
import { startQuickTunnel, startCustomTunnel } from './tunnel.js';
import { qrDataUrl } from './qr.js';

function lanIPv4() {
  const ifaces = networkInterfaces();
  const phys = [];
  const fallback = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue;
      const isPhysical = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i.test(name);
      (isPhysical ? phys : fallback).push(a.address);
    }
  }
  return phys[0] ?? fallback[0] ?? null;
}

function lanCandidates() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('127.') && !a.address.startsWith('169.254.')) {
        if (!out.includes(a.address)) out.push(a.address);
      }
    }
  }
  return out;
}

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

/**
 * 创建手机访问服务。
 * @param {object} opts
 * @param {number} opts.dshPort   目标 loopback 服务端口
 * @param {number} [opts.port]    代理端口（默认 3082）
 * @param {string} opts.home      配置目录（内嵌：~/.deepfusion；CLI：~/.dshtunnel）
 * @param {object} [opts.internals] 测试注入：createProxy / startTunnel
 */
export function createTunnelService({ dshPort, port = 3082, home, internals = {}, onTunnelReady } = {}) {
  if (!home) throw new Error('缺少 home 配置目录');
  const createProxy = internals.createProxy ?? createPocketProxy;
  const startTunnelFn = internals.startTunnel ?? null;

  let settings = null;
  let pin = null;
  let sessionKey = null;
  let rateLimit = null;
  let proxy = null;
  let tunnel = null;
  let tunnelAbort = null;
  let tunnelPromise = null;
  const tunnelState = { phase: 'idle', detail: '', startedAt: null, mode: 'quick' };
  const qrCache = new Map();

  async function qrCached(text) {
    if (!text) return null;
    if (!qrCache.has(text)) {
      if (qrCache.size >= 8) qrCache.delete(qrCache.keys().next().value);
      qrCache.set(text, qrDataUrl(text).catch(() => null));
    }
    return qrCache.get(text);
  }

  /** 当前生效的公网主机（隧道 URL 或自定义配置 publicUrl）。 */
  function currentPublicHost() {
    const u = tunnel?.url || (settings ? settings.tunnelConfig(home).publicUrl : '');
    return hostOf(u);
  }

  async function ensureModules() {
    if (settings && pin) return;
    settings = await import('./settings.js');
    pin = await import('./pin.js');
  }

  const svc = {
    dshPort,

    /** 启动局域网代理（幂等；端口被占自动 +1 尝试）。 */
    async startProxy() {
      await ensureModules();
      if (proxy) return proxy;
      sessionKey = sessionKey ?? pin.createSessionKey();
      rateLimit = rateLimit ?? new pin.RateLimiter();
      const auth = {
        sessionKey,
        rateLimit,
        getToken: (host) => {
          const ph = currentPublicHost();
          const isPublic = (ph && String(host).split(':')[0] === ph.split(':')[0]) || /trycloudflare\.com$/i.test(String(host || ''));
          return isPublic ? settings.getPublicPin(home) : settings.getLanPin(home);
        },
        isProtected: (host) => {
          const ph = currentPublicHost();
          const isPublic = (ph && String(host).split(':')[0] === ph.split(':')[0]) || /trycloudflare\.com$/i.test(String(host || ''));
          return isPublic ? true : settings.lanAuthEnabled(home);
        },
      };
      let lastErr = null;
      for (let p = port; p < port + 10; p++) {
        try {
          proxy = await createProxy({
            port: p,
            host: '0.0.0.0',
            upstream: { host: '127.0.0.1', port: dshPort },
            auth,
          });
          if (p !== port) console.log('dshtunnel: 端口 ' + port + ' 被占用，代理改用 ' + p);
          break;
        } catch (err) {
          if (err?.code !== 'EADDRINUSE') throw err;
          lastErr = err;
        }
      }
      if (!proxy) throw lastErr ?? new Error('代理启动失败');
      return proxy;
    },

    /** 启动公网隧道（幂等；单飞防孤儿 cloudflared）。 */
    async startTunnel() {
      await ensureModules();
      await svc.startProxy();
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise;
      const cfg = settings.tunnelConfig(home);
      tunnelState.mode = cfg.mode;
      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase) => {
        tunnelState.phase = phase;
        tunnelState.detail = phase === 'downloading' ? '首次下载 cloudflared（约 50MB）| first run downloads cloudflared'
          : phase === 'starting' ? '启动隧道进程… | starting tunnel…'
          : phase === 'registering' ? '连接 Cloudflare 边缘（通常 5-30 秒）| connecting to Cloudflare edge'
          : phase === 'ready' ? '隧道就绪 | ready'
          : phase === 'error' ? '隧道错误 | tunnel error'
          : '';
      };
      const starter = startTunnelFn
        ?? (cfg.mode === 'quick' ? startQuickTunnel : (o) => startCustomTunnel({ ...o, config: cfg }));
      const p = (async () => {
        try {
          const result = await starter({ port: proxy.port, home, signal: controller.signal, onPhase });
          tunnel = typeof result === 'string' ? { url: result, kill: () => {}, onExit: () => () => {} } : result;
          tunnelState.phase = 'ready';
          tunnel.onExit?.((code) => {
            if (controller.signal.aborted) return;
            tunnelState.phase = 'error';
            tunnelState.detail = '隧道进程退出（code=' + code + '）| tunnel process exited';
          });
          settings.setAutoTunnel(home);
          try { await onTunnelReady?.(); } catch {}
          return tunnel.url;
        } catch (err) {
          if (!controller.signal.aborted) {
            tunnelState.phase = 'error';
            tunnelState.detail = err?.message ?? String(err);
          }
          tunnelState.startedAt = null;
          throw err;
        } finally {
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },

    /** 停止公网隧道（代理保持）。 */
    stopTunnel() {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null;
      if (tunnel) tunnel.kill();
      tunnel = null;
      tunnelState.phase = 'idle';
      tunnelState.detail = '';
      tunnelState.startedAt = null;
      settings?.clearAutoTunnel(home);
    },

    /** 启动时自动恢复上次开启的公网隧道。 */
    async restoreTunnelIfNeeded() {
      await ensureModules();
      if (tunnel || tunnelPromise) return;
      if (!settings.hasAutoTunnel(home)) return;
      try {
        await svc.startTunnel();
        console.log('dshtunnel: 公网隧道已自动恢复 | public tunnel auto-restored');
      } catch (err) {
        console.warn('dshtunnel: 自动恢复隧道失败: ' + (err?.message ?? err));
      }
    },

    /** 状态快照。 */
    async status() {
      await ensureModules();
      const override = String(settings.lanIpOverride(home) || '').trim();
      const lan = override || lanIPv4();
      const proxyPort = proxy?.port ?? null;
      const lanUrl = lan && proxyPort ? 'http://' + lan + ':' + proxyPort : null;
      const cands = lanCandidates();
      if (override && !cands.includes(override)) cands.push(override);
      return {
        proxyRunning: proxy !== null,
        proxyPort,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates: cands,
        lanIpOverride: override,
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnel?.url ?? null,
        tunnelQr: await qrCached(tunnel?.url ?? null),
        tunnelState: { ...tunnelState },
        tunnelConfig: settings.tunnelConfig(home),
        dshPort,
      };
    },

    /** 停止一切（进程退出时调用）。 */
    async dispose() {
      svc.stopTunnel();
      if (proxy) {
        const pr = proxy;
        proxy = null;
        try { await pr.close(); } catch {}
      }
    },
  };
  return svc;
}
