// pin.js — 8 位 PIN 会话认证 + 登录限速
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getPublicPin, getLanPin, rotatePublicPin, refreshLanPin, setPinCustom, writePin, pinCustom, PIN_RE } from './settings.js';

export function createSessionKey() { return randomBytes(16).toString('hex'); }

export function signSession(pin, sessionKey) {
  return createHash('sha256').update(pin + ':' + sessionKey).digest('hex');
}

export function validSession(cookieHeader, pin, sessionKey) {
  if (!cookieHeader || !pin || !sessionKey) return false;
  const expected = signSession(pin, sessionKey);
  const m = String(cookieHeader).match(/(?:^|;\s*)dfp_auth=v1\.([0-9a-f]{64})/);
  if (!m) return false;
  try {
    return timingSafeEqual(Buffer.from(m[1], 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

export function sessionCookie(pin, sessionKey) {
  const v = 'v1.' + signSession(pin, sessionKey);
  return 'dfp_auth=' + v + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';
}

export function clearCookie() {
  return 'dfp_auth=; Path=/; HttpOnly; Max-Age=0';
}

// ---------- 登录限速：同 IP 错 5 次锁 60s；全局熔断 ----------
export class RateLimiter {
  constructor({ maxFails = 5, lockMs = 60000, globalMax = 50, globalLockMs = 300000 } = {}) {
    this.maxFails = maxFails;
    this.lockMs = lockMs;
    this.globalMax = globalMax;
    this.globalLockMs = globalLockMs;
    this.fails = new Map(); // ip -> { count, lockedUntil }
    this.globalFails = []; // timestamps
    this.globalLockedUntil = 0;
  }
  check(ip) {
    const now = Date.now();
    if (this.globalLockedUntil > now) return { ok: false, lockedUntil: this.globalLockedUntil, global: true };
    const rec = this.fails.get(ip);
    if (rec && rec.lockedUntil > now) return { ok: false, lockedUntil: rec.lockedUntil, global: false };
    return { ok: true };
  }
  fail(ip) {
    const now = Date.now();
    const rec = this.fails.get(ip) || { count: 0, lockedUntil: 0 };
    rec.count += 1;
    this.globalFails.push(now);
    if (rec.count >= this.maxFails) {
      rec.lockedUntil = now + this.lockMs;
      rec.count = 0;
    }
    this.fails.set(ip, rec);
    // 全局熔断：窗口内失败超阈值
    this.globalFails = this.globalFails.filter(t => now - t < this.globalLockMs);
    if (this.globalFails.length >= this.globalMax) {
      this.globalLockedUntil = now + this.globalLockMs;
      this.globalFails = [];
    }
  }
  reset(ip) {
    this.fails.delete(ip);
  }
}

// ---------- PIN 应用层操作（按 home 隔离） ----------
export function makePinService(home) {
  return {
    publicPin: () => getPublicPin(home),
    lanPin: () => getLanPin(home),
    rotatePublic: () => rotatePublicPin(home, pinCustom(home, 'public')),
    refreshLan: () => refreshLanPin(home),
    custom: (which, value) => {
      const v = String(value ?? '').trim();
      if (!PIN_RE.test(v)) throw new Error('PIN 必须是 8 位数字 | PIN must be exactly 8 digits');
      writePin(home, which, v);
      setPinCustom(home, which, true);
      return v;
    },
    lanAuthOn: () => lanAuthEnabled(home),
    setLanAuthOn: (on) => setLanAuthEnabled(home, on),
    isCustom: (which) => pinCustom(home, which),
  };
}