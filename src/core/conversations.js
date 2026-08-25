/**
 * conversations.js — 对话持久化
 * data/conversations/conv-<id>.json
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const CONV_DIR = path.join(process.cwd(), 'data', 'conversations');

function ensureDir() { mkdirSync(CONV_DIR, { recursive: true }); }
function convPath(id) { return path.join(CONV_DIR, id.endsWith('.json') ? id : id + '.json'); }

function now() { return new Date().toISOString(); }

/** 清洗乱码文本：U+FFFD 替换符 / 控制字符 → 兜底显示 */
export function sanitizeText(s, fallback = '（内容不可读）') {
  if (!s) return s;
  let t = String(s);
  // 统计替换符占比
  const bad = (t.match(/\uFFFD/g) || []).length;
  const ratio = t.length ? bad / t.length : 0;
  if (ratio > 0.2) return fallback;               // 大量替换符 → 兜底
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');  // 控制字符
  return t;
}

/** 清洗对话对象（标题 + 消息内容），兼容旧乱码数据 */
export function sanitizeConversation(c) {
  if (!c) return c;
  c.title = sanitizeText(c.title, '历史对话');
  if (Array.isArray(c.messages)) {
    for (const m of c.messages) {
      if (m && typeof m.content === 'string') m.content = sanitizeText(m.content, '（消息内容不可读）');
    }
  }
  return c;
}

/** 列出对话（按更新时间倒序） */
export function listConversations() {
  ensureDir();
  const list = [];
  for (const f of readdirSync(CONV_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      let c = JSON.parse(readFileSync(path.join(CONV_DIR, f), 'utf8'));
      c = sanitizeConversation(c);
      list.push({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: (c.messages || []).length });
    } catch {}
  }
  return list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/** 读对话 */
export function getConversation(id) {
  const p = convPath(id);
  if (!existsSync(p)) return null;
  try { return sanitizeConversation(JSON.parse(readFileSync(p, 'utf8'))); } catch { return null; }
}

/** 新建对话 */
export function createConversation(title) {
  ensureDir();
  const id = 'conv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const c = {
    id,
    title: title || '新对话',
    createdAt: now(),
    updatedAt: now(),
    messages: []
  };
  writeFileSync(convPath(id), JSON.stringify(c, null, 2), 'utf8');
  return c;
}

/** 追加消息并保存 */
export function appendMessage(conv, role, content, usage = null) {
  content = sanitizeText(content, '');
  conv.messages.push({ role, content, usage: usage || null, at: now() });
  if (role === 'user' && conv.title === '新对话' && content) {
    conv.title = content.slice(0, 30) + (content.length > 30 ? '…' : '');
  }
  conv.updatedAt = now();
  writeFileSync(convPath(conv.id), JSON.stringify(conv, null, 2), 'utf8');
  return conv;
}

/** 构造多轮上下文 prompt（最近 MAX 条，越新越重要） */
export function buildContextPrompt(conv, current, maxMessages = 8) {
  const parts = [];
  const recent = conv.messages.slice(-maxMessages);
  for (const m of recent) {
    if (m.role === 'user' || m.role === 'assistant') {
      parts.push((m.role === 'user' ? '用户' : '助手') + ': ' + m.content.slice(0, 2000));
    }
  }
  parts.push('用户: ' + current);
  return parts.join('\n\n');
}