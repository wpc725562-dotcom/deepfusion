/**
 * manager.js — Reasonix 引擎管理器：检测 / 配置 / 状态
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'engine.json');

/** 检测 reasonix 是否可用（PATH / npx 全局 / 常见位置） */
export function detectReasonix() {
  const results = [];
  // 1. PATH 直接调用
  try {
    const r = spawnSync('reasonix', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.status === 0) {
      results.push({ source: 'PATH', bin: 'reasonix', version: (r.stdout || r.stderr).trim().split('\n')[0] });
    }
  } catch {}
  // 2. npx（npm 包 reasonix）
  try {
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const r = spawnSync(npxBin, ['reasonix', '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status === 0) {
      results.push({ source: 'npx', bin: npxBin, version: (r.stdout || r.stderr).trim().split('\n')[0] });
    }
  } catch {}
  // 3. 常见安装位置（Windows 全局 npm / Go bin）
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'reasonix.cmd'),
    path.join(process.env.USERPROFILE || homedir(), 'go', 'bin', process.platform === 'win32' ? 'reasonix.exe' : 'reasonix'),
    path.join(homedir(), '.local', 'bin', 'reasonix')
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
        results.push({ source: 'path', bin: p, version: (r.stdout || r.stderr || '').trim().split('\n')[0] });
      } catch {}
    }
  }
  return results;
}

/** 读取引擎配置 */
export function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {};
}

/** 保存引擎配置 */
export function saveConfig(cfg) {
  mkdirSync(DATA_DIR, { recursive: true });
  const cur = loadConfig();
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...cur, ...cfg }, null, 2), 'utf8');
  return loadConfig();
}

/** 汇总引擎状态 */
export function engineStatus() {
  const detected = detectReasonix();
  const config = loadConfig();
  const selected = config.bin
    ? detected.find(d => d.bin === config.bin) || null
    : detected[0] || null;
  return {
    detected,
    configured: config,
    selected: selected ? { source: selected.source, bin: selected.bin, version: selected.version } : null,
    usable: !!selected,
    hint: selected ? null : '未检测到 reasonix。安装：npm i -g reasonix，然后运行 reasonix setup 配置 DeepSeek API key。'
  };
}

/** 生成 npx 启动指令（供 spawn 用） */
export function resolveLaunch(engines) {
  const e = engines.selected || engines.detected[0] || null;
  if (!e) return null;
  if (e.source === 'npx') {
    return { useNpx: true, bin: 'reasonix' };
  }
  return { useNpx: false, bin: e.bin };
}
