// proxy.js — 改头反向代理：把 loopback 服务经 0.0.0.0:<port> 暴露给手机
//  - Host/Origin 重写回 upstream（127.0.0.1:<dshPort>），浏览器信任栅栏始终见 loopback
//  - 认证门：公网主机永远校验 8 位 PIN；局域网按 lanAuthEnabled 开关
//  - HTTP + SSE 全透传；WebSocket upgrade 原样转发（兼容 DSH mux / 任意 WS 服务）
//  - 登录页 /__dfauth（本代理本地处理，不转发到 upstream）
import http from 'node:http';
import { URL } from 'node:url';
import { validSession, sessionCookie, clearCookie } from './pin.js';

export const COOKIE_NAME = 'dfp_auth';
const LOCAL_PATHS = ['/__dfauth', '/__dfauth/verify', '/__dfauth/logout'];

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function loopbackHeaders(headers, upstream) {
  const out = { ...headers };
  out.host = upstream.host + ':' + upstream.port;
  if (out.origin) out.origin = 'http://' + upstream.host + ':' + upstream.port;
  if (out['sec-websocket-origin']) out['sec-websocket-origin'] = 'http://' + upstream.host + ':' + upstream.port;
  delete out['x-forwarded-host'];
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function loginPage(next, err) {
  const lines = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>DeepFusion 手机访问</title><style>',
    'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0b0e14;color:#e8eaed;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}',
    '.card{background:#1a1d27;border-radius:16px;padding:36px;width:320px;box-shadow:0 8px 32px rgba(0,0,0,.4)}',
    'h1{font-size:18px;margin:0 0 6px}',
    '.desc{color:#9aa0a6;font-size:13px;margin-bottom:20px}',
    'input{width:100%;padding:12px;font-size:18px;letter-spacing:6px;text-align:center;border-radius:8px;border:1px solid #3c4043;background:#262a36;color:#fff;box-sizing:border-box}',
    'button{margin-top:16px;width:100%;padding:12px;font-size:15px;border:none;border-radius:8px;background:#1a73e8;color:#fff;cursor:pointer}',
    '.err{color:#f28b82;font-size:13px;margin-top:10px;text-align:center}',
    '.foot{margin-top:20px;color:#5f6368;font-size:11px;text-align:center}',
    '</style></head><body><div class="card">',
    '<h1>🔐 DeepFusion 手机访问</h1>',
    '<div class="desc">请输入访问密码（8 位数字）</div>',
    '<form method="POST" action="/__dfauth/verify">',
    '<input type="hidden" name="next" value="' + esc(next) + '">',
    '<input type="password" name="pin" inputmode="numeric" maxlength="8" autocomplete="off" autofocus required>',
    '<button type="submit">进入</button>',
    '</form>' + (err ? '<div class="err">' + esc(err) + '</div>' : ''),
    '<div class="foot">密码验证通过后长期免输 · 重启电脑端后需重新输入</div>',
    '</div></body></html>',
  ];
  return lines.join('');
}

function readForm(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 65536) req.destroy(); });
    req.on('end', () => {
      const out = {};
      for (const part of raw.split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const k = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
        const v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
        out[k] = v;
      }
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * 创建手机访问代理。
 * @param {object} opts
 * @param {number} opts.port        监听端口（默认 3082）
 * @param {string} [opts.host]      监听地址（默认 0.0.0.0）
 * @param {{host:string,port:number}} opts.upstream 目标 loopback 服务
 * @param {object} [opts.auth] 认证配置：{ getToken(host), isProtected(host), sessionKey, rateLimit }
 * @param {string} [opts.injectHtml] 注入到 HTML 响应的脚本（可选）
 * @returns {Promise<{server, port, close}>}
 */
export async function createPocketProxy({ port = 3082, host = '0.0.0.0', upstream, auth = null, injectHtml = null }) {
  if (!upstream || !upstream.port) throw new Error('缺少 upstream');

  const rate = auth?.rateLimit ?? null;

  const handleLocal = async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__dfauth' && req.method === 'GET') {
      const html = loginPage(u.searchParams.get('next') || '/', u.searchParams.get('err') || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return true;
    }
    if (u.pathname === '/__dfauth/verify' && req.method === 'POST') {
      const form = await readForm(req);
      const ip = clientIp(req);
      const gate = rate ? rate.check(ip) : { ok: true };
      if (!gate.ok) {
        const left = Math.max(1, Math.ceil((gate.lockedUntil - Date.now()) / 1000));
        res.writeHead(302, { Location: '/__dfauth?next=' + encodeURIComponent(form.next || '/') + '&err=' + encodeURIComponent('尝试次数过多，请 ' + left + ' 秒后再试') });
        res.end();
        return true;
      }
      const host = String(req.headers.host || '');
      const token = auth?.getToken?.(host) ?? '';
      if (String(form.pin || '') === token) {
        rate?.reset(ip);
        const cookie = sessionCookie(token, auth?.sessionKey);
        res.writeHead(302, { Location: form.next || '/', 'Set-Cookie': cookie });
        res.end();
      } else {
        rate?.fail(ip);
        res.writeHead(302, { Location: '/__dfauth?next=' + encodeURIComponent(form.next || '/') + '&err=' + encodeURIComponent('密码错误') });
        res.end();
      }
      return true;
    }
    if (u.pathname === '/__dfauth/logout' && req.method === 'POST') {
      res.writeHead(302, { Location: '/', 'Set-Cookie': clearCookie() });
      res.end();
      return true;
    }
    return false;
  };

  const authed = (req) => {
    const host = String(req.headers.host || '');
    const protectedHost = auth?.isProtected ? auth.isProtected(host) : false;
    if (!protectedHost) return { ok: true };
    const token = auth?.getToken?.(host) ?? '';
    if (validSession(req.headers.cookie, token, auth?.sessionKey)) return { ok: true };
    return { ok: false };
  };

  const proxyReq = (req, res) => {
    const headers = loopbackHeaders(req.headers, upstream);
    const fwd = clientIp(req);
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? headers['x-forwarded-for'] + ', ' + fwd : fwd;
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    const r = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false }, (up) => {
      const outHeaders = { ...up.headers };
      delete outHeaders['transfer-encoding'];
      res.writeHead(up.statusCode || 502, outHeaders);
      if (injectHtml && /text\/html/i.test(String(up.headers['content-type'] || ''))) {
        let buf = '';
        up.on('data', d => { buf += d; });
        up.on('end', () => {
          try {
            res.end(buf.replace('</body>', injectHtml + '</body>'));
          } catch { res.end(buf); }
        });
      } else {
        up.pipe(res);
      }
    });
    r.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dshtunnel: 无法连接上游服务（' + upstream.host + ':' + upstream.port + '）| upstream unreachable');
      } else res.destroy();
    });
    req.pipe(r);
  };

  const server = http.createServer(async (req, res) => {
    if (await handleLocal(req, res)) return;
    const a = authed(req);
    if (!a.ok) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const u = new URL(req.url, 'http://x');
        const next = u.pathname + (u.search ? u.search : '');
        res.writeHead(302, { Location: '/__dfauth?next=' + encodeURIComponent(next) });
        res.end();
        return;
      }
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('401 Unauthorized');
      return;
    }
    proxyReq(req, res);
  });

  // WebSocket upgrade 透传（同样过认证门）
  server.on('upgrade', (req, socket, head) => {
    const a = authed(req);
    if (!a.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = loopbackHeaders(req.headers, upstream);
    const r = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false });
    r.on('upgrade', (up, upSocket, upHead) => {
      const raw = ['HTTP/1.1 101 Switching Protocols'];
      for (const [k, v] of Object.entries(up.headers)) raw.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
      socket.write(raw.join('\r\n') + '\r\n\r\n');
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const teardown = () => { try { upSocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
      upSocket.on('error', () => { try { socket.destroy(); } catch {} });
      upSocket.on('close', teardown);
      socket.on('close', teardown);
      socket.on('error', () => { try { upSocket.destroy(); } catch {} });
    });
    r.on('response', (up) => {
      try {
        const raw = ['HTTP/1.1 ' + (up.statusCode || 502) + ' ' + (up.statusMessage || '')];
        for (const [k, v] of Object.entries(up.headers)) raw.push(k + ': ' + (Array.isArray(v) ? v.join(', ') : v));
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        up.resume();
      } catch { socket.destroy(); }
    });
    r.on('error', () => socket.destroy());
    if (head?.length) r.write(head);
    r.end();
    socket.on('error', () => { try { r.destroy(); } catch {} });
  });

  // 连接跟踪（closeAllConnections 不含 upgrade 后的 socket）
  const clientSockets = new Set();
  server.on('connection', (s) => {
    clientSockets.add(s);
    s.on('close', () => clientSockets.delete(s));
    s.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r2) => {
          for (const s of clientSockets) { try { s.destroy(); } catch {} }
          server.close(() => r2());
        }),
      });
    });
  });
}
