// settings.js — 手机访问配置持久化（DeepFusion 内嵌与独立 CLI 共用）
// 目录：<home>/dshtunnel/
//   settings.json       开关与标记（lanAuthEnabled / publicPinCustom / lanPinCustom / lanIpOverride）
//   token               公网 8 位 PIN（明文，0600）
//   token-lan           局域网 8 位 PIN
//   tunnel-config.json  公网隧道配置（mode: quick|token|named|external）
//   tunnel-auto.json    公网隧道「开启中」标记（进程重启后自动恢复）
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REL_DIR = join('dshtunnel', 'settings.json');
export function settingsPath(home) { return join(home, REL_DIR); }

function readSettings(home) {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function writeSettings(home, s) {
  try {
    mkdirSync(join(home, 'dshtunnel'), { recursive: true });
    writeFileSync(settingsPath(home), JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return s;
}

export const PIN_RE = /^\d{8}$/;
export function newPin() { return String(Math.floor(10000000 + Math.random() * 90000000)); }
function readPinFile(p) {
  try {
    const v = readFileSync(p, 'utf8').trim();
    if (PIN_RE.test(v)) return v;
  } catch { /* 无文件 */ }
  return null;
}
function writePinFile(p, v) {
  try {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, v, { mode: 0o600 });
  } catch { /* 忽略 */ }
  return v;
}

// ---------- 公网 PIN ----------
export function tokenPath(home) { return join(home, 'dshtunnel', 'token'); }
export function getPublicPin(home) { return readPinFile(tokenPath(home)) ?? writePinFile(tokenPath(home), newPin()); }
export function rotatePublicPin(home, custom) {
  if (custom) return getPublicPin(home);
  return writePinFile(tokenPath(home), newPin());
}

// ---------- 直接写入 PIN（自定义） ----------
export function writePin(home, which, value) {
  const v = String(value ?? '').trim();
  if (!PIN_RE.test(v)) throw new Error('PIN 必须是 8 位数字 | PIN must be exactly 8 digits');
  if (which === 'public') return writePinFile(tokenPath(home), v);
  if (which === 'lan') return writePinFile(lanTokenPath(home), v);
  throw new Error('未知 PIN 类型 | unknown PIN kind');
}

// ---------- 局域网 PIN ----------
export function lanTokenPath(home) { return join(home, 'dshtunnel', 'token-lan'); }
export function getLanPin(home) { return readPinFile(lanTokenPath(home)) ?? writePinFile(lanTokenPath(home), newPin()); }
export function refreshLanPin(home) {
  setPinCustom(home, 'lan', false);
  return writePinFile(lanTokenPath(home), newPin());
}

// ---------- 开关与自定义标记 ----------
const PIN_CUSTOM_KEYS = { public: 'publicPinCustom', lan: 'lanPinCustom' };
export function lanAuthEnabled(home) { return readSettings(home).lanAuthEnabled !== false; }
export function setLanAuthEnabled(home, on) {
  const s = readSettings(home);
  s.lanAuthEnabled = !!on;
  writeSettings(home, s);
  return s.lanAuthEnabled;
}
export function lanIpOverride(home) {
  const v = String(readSettings(home).lanIpOverride ?? '').trim();
  return isValidIpv4(v) ? v : '';
}
export function setLanIpOverride(home, value) {
  const ip = String(value ?? '').trim();
  if (ip && !isValidIpv4(ip)) throw new Error('局域网地址必须是 IPv4 | LAN address must be IPv4');
  const s = readSettings(home);
  if (ip) s.lanIpOverride = ip; else delete s.lanIpOverride;
  writeSettings(home, s);
  return ip;
}
export function pinCustom(home, which) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  return readSettings(home)[key] === true;
}
export function setPinCustom(home, which, on) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  const s = readSettings(home);
  s[key] = !!on;
  writeSettings(home, s);
  return !!on;
}
export function isValidIpv4(s) {
  if (typeof s !== 'string' || !s) return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

// ---------- 自定义公网隧道配置（自己配置公网隧道） ----------
export const TUNNEL_MODES = ['quick', 'token', 'named', 'external'];
export function tunnelConfigPath(home) { return join(home, 'dshtunnel', 'tunnel-config.json'); }
export function tunnelConfig(home) {
  try {
    const c = JSON.parse(readFileSync(tunnelConfigPath(home), 'utf8'));
    if (!c || typeof c !== 'object') return defaultTunnelConfig();
    return { ...defaultTunnelConfig(), ...c };
  } catch { return defaultTunnelConfig(); }
}
export function defaultTunnelConfig() {
  return { mode: 'quick', token: '', name: '', publicUrl: '', bin: '' };
}
export function saveTunnelConfig(home, cfg) {
  const c = { ...defaultTunnelConfig(), ...(cfg || {}) };
  if (!TUNNEL_MODES.includes(c.mode)) throw new Error('未知隧道模式: ' + c.mode);
  if (c.mode !== 'quick' && c.mode !== 'external' && !String(c.publicUrl || '').trim()) {
    throw new Error('token/named 模式必须配置公网地址 publicUrl');
  }
  try {
    mkdirSync(join(home, 'dshtunnel'), { recursive: true });
    writeFileSync(tunnelConfigPath(home), JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return c;
}

// ---------- 自动恢复标记 ----------
function autoStatePath(home) { return join(home, 'dshtunnel', 'tunnel-auto.json'); }
export function setAutoTunnel(home) {
  try {
    mkdirSync(join(home, 'dshtunnel'), { recursive: true });
    writeFileSync(autoStatePath(home), JSON.stringify({ at: Date.now() }), 'utf8');
  } catch { /* 忽略 */ }
}
export function clearAutoTunnel(home) {
  try { rmSync(autoStatePath(home), { force: true }); } catch { /* 忽略 */ }
}
export function hasAutoTunnel(home) {
  try { return /"at"\s*:/.test(readFileSync(autoStatePath(home), 'utf8')); }
  catch { return false; }
}