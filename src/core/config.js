/**
 * config.js — DeepFusion 配置体系
 * 分层：命令行 flag > 环境变量 > 项目级 .deepfusion.toml > 全局 ~/.deepfusion/config.toml
 * 格式：TOML 子集（[section] + key = value，支持 string/number/bool/array）
 * 纯 Node 标准库，无依赖
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.deepfusion');

/** mini TOML 解析器（支持常见子集 + [[array.of.tables]]） */
export function parseToml(text) {
  const root = {};
  let section = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.startsWith('[[') && line.endsWith(']]')) {
      const name = line.slice(2, -2).trim();
      const parts = name.split('.');
      let cur = root;
      for (const part of parts.slice(0, -1)) {
        if (!cur[part]) cur[part] = {};
        cur = cur[part];
      }
      const last = parts[parts.length - 1];
      if (!cur[last]) cur[last] = [];
      const entry = {};
      cur[last].push(entry);
      section = entry;
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      section = root;
      for (const part of name.split('.')) {
        section[part] = section[part] || {};
        section = section[part];
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 数组
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => parseScalar(s.trim())).filter(v => v !== undefined);
    } else {
      val = parseScalar(val);
    }
    if (val !== undefined) section[key] = val;
  }
  return root;
}

function parseScalar(s) {
  if (s === undefined || s === '') return undefined;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  if (!Number.isNaN(n) && s !== '') return n;
  return s;
}

/** 渲染 TOML（写回配置用） */
export function renderToml(obj) {
  const lines = [];
  for (const [sec, vals] of Object.entries(obj)) {
    if (vals && typeof vals === 'object' && !Array.isArray(vals)) {
      lines.push('[' + sec + ']');
      for (const [k, v] of Object.entries(vals)) {
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') {
          for (const item of v) {
            lines.push('[[' + sec + '.' + k + ']]');
            for (const [ik, iv] of Object.entries(item)) lines.push(renderKV(ik, iv));
          }
        } else {
          lines.push(renderKV(k, v));
        }
      }
      lines.push('');
    } else if (Array.isArray(vals) && vals.length && vals[0] && typeof vals[0] === 'object') {
      // array of tables
      for (const item of vals) {
        lines.push('[[' + sec + ']]');
        for (const [k, v] of Object.entries(item)) lines.push(renderKV(k, v));
        lines.push('');
      }
    } else {
      lines.push(renderKV(sec, vals));
    }
  }
  return lines.join('\n').trim() + '\n';
}
function renderKV(k, v) {
  if (Array.isArray(v)) return k + ' = [' + v.map(x => typeof x === 'string' ? JSON.stringify(x) : String(x)).join(', ') + ']';
  if (typeof v === 'string') return k + ' = ' + JSON.stringify(v);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return k + ' = ' + String(v);
}

/** 默认配置 */
export function defaultConfig() {
  return {
    engine: { bin: 'reasonix', model: 'deepseek-chat', compactRatio: 0.85, timeoutMs: 180000 },
    plugins: { enabled: [] },
    mcp: { servers: [], expose: false },
    skills: { dir: path.join(CONFIG_DIR, 'skills'), autoInject: true },
    permission: { mode: 'allow' },
    budget: { dailyTokens: 0, currency: 'CNY' },
    ui: { theme: 'reasonix', defaultTab: 'chat' }
  };
}

/** 读取全局配置 */
export function loadGlobalConfig() {
  const p = path.join(CONFIG_DIR, 'config.toml');
  if (!existsSync(p)) return defaultConfig();
  try {
    const parsed = parseToml(readFileSync(p, 'utf8'));
    const d = defaultConfig();
    return deepMerge(d, parsed);
  } catch { return defaultConfig(); }
}

/** 读取项目配置（当前目录向上找 .deepfusion.toml） */
export function loadProjectConfig() {
  let dir = process.cwd();
  while (true) {
    const p = path.join(dir, '.deepfusion.toml');
    if (existsSync(p)) {
      try { return parseToml(readFileSync(p, 'utf8')); } catch { return {}; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

/** 读取最终生效配置（项目覆盖全局，环境变量覆盖） */
export function loadConfig() {
  const cfg = loadGlobalConfig();
  const proj = loadProjectConfig();
  const merged = deepMerge(cfg, proj);
  // 环境变量覆盖
  if (process.env.DEEPSEEK_API_KEY) merged.engine.apiKeyEnv = 'DEEPSEEK_API_KEY';
  if (process.env.DEEPFUSION_MODEL) merged.engine.model = process.env.DEEPFUSION_MODEL;
  if (process.env.DEEPFUSION_DAILY_TOKENS) merged.budget.dailyTokens = Number(process.env.DEEPFUSION_DAILY_TOKENS);
  return merged;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 保存全局配置 */
export function saveGlobalConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path.join(CONFIG_DIR, 'config.toml'), renderToml(cfg), 'utf8');
}

/** 确保技能目录存在 */
export function ensureDirs() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(path.join(CONFIG_DIR, 'plugins'), { recursive: true });
  mkdirSync(path.join(CONFIG_DIR, 'skills'), { recursive: true });
}