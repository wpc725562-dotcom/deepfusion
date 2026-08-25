// test.js — dshtunnel 离线测试（不启动真实隧道，不依赖网络）
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import * as settings from '../lib/settings.js';
import * as pin from '../lib/pin.js';
import { QUICK_TUNNEL_URL_RE } from '../lib/tunnel.js';
import { createPocketProxy } from '../lib/proxy.js';
import { qrDataUrl, qrTerminal } from '../lib/qr.js';

const HOME = mkdtempSync(path.join(tmpdir(), 'dshtunnel-test-'));

test('settings: LAN auth defaults to on, toggle persists', () => {
  assert.equal(settings.lanAuthEnabled(HOME), true);
  settings.setLanAuthEnabled(HOME, false);
  assert.equal(settings.lanAuthEnabled(HOME), false);
  settings.setLanAuthEnabled(HOME, true);
  assert.equal(settings.lanAuthEnabled(HOME), true);
});

test('settings: PIN validation and custom write', () => {
  const good = '12345678';
  assert.ok(settings.PIN_RE.test(good));
  assert.ok(!settings.PIN_RE.test('1234567'));
  settings.writePin(HOME, 'public', good);
  assert.equal(settings.getPublicPin(HOME), good);
  settings.setPinCustom(HOME, 'public', true);
  assert.equal(settings.pinCustom(HOME, 'public'), true);
  assert.throws(() => settings.writePin(HOME, 'public', 'abc'), /8 位/);
});

test('settings: tunnel config default and modes', () => {
  const c = settings.tunnelConfig(HOME);
  assert.equal(c.mode, 'quick');
  settings.saveTunnelConfig(HOME, { mode: 'external', publicUrl: 'https://t.example.com' });
  assert.equal(settings.tunnelConfig(HOME).mode, 'external');
  assert.throws(() => settings.saveTunnelConfig(HOME, { mode: 'bogus' }), /未知/);
  assert.throws(() => settings.saveTunnelConfig(HOME, { mode: 'token' }), /publicUrl/);
});

test('settings: auto-tunnel marker round trip', () => {
  assert.equal(settings.hasAutoTunnel(HOME), false);
  settings.setAutoTunnel(HOME);
  assert.equal(settings.hasAutoTunnel(HOME), true);
  settings.clearAutoTunnel(HOME);
  assert.equal(settings.hasAutoTunnel(HOME), false);
});

test('pin: session cookie round trip', () => {
  const key = pin.createSessionKey();
  const cookie = pin.sessionCookie('12345678', key);
  assert.equal(pin.validSession(cookie, '12345678', key), true);
  assert.equal(pin.validSession(cookie, '87654321', key), false);
  assert.equal(pin.validSession(cookie, '12345678', 'other-key'), false);
  assert.equal(pin.validSession(null, '12345678', key), false);
});

test('pin: rate limiter locks after 5 fails', () => {
  const rl = new pin.RateLimiter({ maxFails: 5, lockMs: 5000, globalMax: 1000 });
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.check('1.2.3.4').ok, true);
    rl.fail('1.2.3.4');
  }
  const locked = rl.check('1.2.3.4');
  assert.equal(locked.ok, false);
  // 其他 IP 不受影响
  assert.equal(rl.check('5.6.7.8').ok, true);
});

test('tunnel: quick tunnel URL regex excludes api host', () => {
  assert.ok(QUICK_TUNNEL_URL_RE.test('https://pressed-value-continuous-visiting.trycloudflare.com'));
  assert.ok(!QUICK_TUNNEL_URL_RE.test('https://api.trycloudflare.com'));
  assert.ok(!QUICK_TUNNEL_URL_RE.test('https://example.com'));
});

test('qr: data URL and terminal output', async () => {
  const uri = await qrDataUrl('http://192.168.1.1:3082');
  assert.ok(uri.startsWith('data:image/png;base64,'));
  const term = await qrTerminal('http://192.168.1.1:3082');
  assert.ok(term.includes('▀') || term.includes('█') || term.length > 100);
});

test('proxy: auth gate redirects, login sets cookie, cookie passes through', async () => {
  // 上游模拟服务
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('upstream-ok:' + req.url);
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const auth = {
    sessionKey: 'session-key-test',
    getToken: () => '12345678',
    isProtected: () => true,
    rateLimit: new pin.RateLimiter(),
  };
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: upPort }, auth });
  const port = proxy.port;

  const get = (p, headers = {}) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
  });
  const post = (p, bodyStr, headers = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.end(bodyStr);
  });

  // 1) 未认证 → 302 到登录页
  const r1 = await get('/');
  assert.equal(r1.status, 302);
  assert.ok(r1.headers.location.startsWith('/__dfauth?next='));

  // 2) 登录页可达
  const r2 = await get('/__dfauth');
  assert.equal(r2.status, 200);
  assert.ok(r2.body.includes('访问密码'));

  // 3) 错误密码 → 302 err
  const r3 = await post('/__dfauth/verify', 'pin=00000000&next=/');
  assert.equal(r3.status, 302);
  assert.ok(r3.headers.location.includes('err='));

  // 4) 正确密码 → 302 + Set-Cookie
  const r4 = await post('/__dfauth/verify', 'pin=12345678&next=/');
  assert.equal(r4.status, 302);
  assert.ok(r4.headers['set-cookie']?.[0]?.startsWith('dfp_auth='));

  // 5) 带 cookie 访问 → 透传到上游
  const cookie = r4.headers['set-cookie'][0].split(';')[0];
  const r5 = await get('/hello', { Cookie: cookie, Host: 'anything.trycloudflare.com' });
  assert.equal(r5.status, 200);
  assert.equal(r5.body, 'upstream-ok:/hello');

  await new Promise(r => proxy.close().then(r));
  await new Promise(r => upstream.close(r));
});
