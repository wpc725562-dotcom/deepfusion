/**
 * queue.js — 任务队列（兼容 dsh-command-center 协议）
 * 任务文件：data/tasks/task-<id>.json
 * 状态机：pending → assigned → done；支持 stalled（超时）标记
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TASKS_DIR = path.join(process.cwd(), 'data', 'tasks');
const STALL_MS = 15 * 60 * 1000; // 15 分钟静默检测

function ensureDir() { mkdirSync(TASKS_DIR, { recursive: true }); }

function taskPath(id) { return path.join(TASKS_DIR, id.endsWith('.json') ? id : id + '.json'); }

/** 读取全部任务（含 stalled 计算字段） */
export function listTasks() {
  ensureDir();
  const now = Date.now();
  const tasks = [];
  for (const f of readdirSync(TASKS_DIR)) {
    if (!f.endsWith('.json') || f === 'task.template.json') continue;
    try {
      const t = JSON.parse(readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      t.stalled = t.status === 'assigned' && t.updatedAt && (now - new Date(t.updatedAt).getTime() > STALL_MS);
      tasks.push(t);
    } catch {}
  }
  return tasks.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/** 读单个任务 */
export function getTask(id) {
  const p = taskPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** 写任务 */
export function writeTask(task) {
  ensureDir();
  writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
  return task;
}

/** 新建任务 */
export function createTask({ title, context, verify, assignee = null }) {
  ensureDir();
  let n = 1;
  const ids = readdirSync(TASKS_DIR).map(f => f.replace('.json', ''));
  while (ids.includes('task-' + String(n).padStart(3, '0'))) n++;
  const id = 'task-' + String(n).padStart(3, '0');
  const now = new Date().toISOString();
  const task = {
    id,
    title: title || '未命名任务',
    context: context || '',
    verify: verify || null,
    status: assignee ? 'assigned' : 'pending',
    owner: assignee || null,
    result: null,
    verifyResult: null,
    stalledAt: null,
    createdAt: now,
    updatedAt: now
  };
  return writeTask(task);
}

/** 任务动作 */
export function applyAction(task, action, body = {}) {
  const now = new Date().toISOString();
  switch (action) {
    case 'claim':
      if (task.status !== 'pending') return { ok: false, error: '任务不在 pending 状态' };
      task.status = 'assigned';
      task.owner = body.owner || 'unknown';
      task.updatedAt = now;
      break;
    case 'done':
      task.status = 'done';
      task.result = body.result || task.result || null;
      task.verifyResult = body.verifyResult || task.verifyResult || null;
      task.updatedAt = now;
      break;
    case 'reopen':
      task.status = 'pending';
      task.owner = null;
      task.result = null;
      task.updatedAt = now;
      break;
    case 'pause':
      if (task.status !== 'assigned') return { ok: false, error: '只有 assigned 任务可暂停' };
      task.status = 'paused';
      task.updatedAt = now;
      break;
    case 'archive':
      task.archived = true;
      task.updatedAt = now;
      break;
    default:
      return { ok: false, error: '未知动作: ' + action };
  }
  writeTask(task);
  return { ok: true, task };
}

/** 统计 */
export function taskStats(tasks = listTasks()) {
  const s = { total: tasks.length, pending: 0, assigned: 0, done: 0, stalled: 0, paused: 0 };
  for (const t of tasks) {
    if (t.status === 'pending') s.pending++;
    else if (t.status === 'assigned') { s.assigned++; if (t.stalled) s.stalled++; }
    else if (t.status === 'done') s.done++;
    else if (t.status === 'paused') s.paused++;
  }
  return s;
}
