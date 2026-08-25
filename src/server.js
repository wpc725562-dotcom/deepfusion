/**
 * server.js — DeepFusion Web 工作台
 * 端口 43210，纯 Node 标准库
 * API:
 *   GET  /                          → 前端页面
 *   GET  /api/overview              → 引擎状态 + 任务统计 + 任务列表
 *   GET  /api/engine                → reasonix 引擎检测详情
 *   GET  /api/ledger                → 成本台账（data/ledger.json）
 *   POST /api/tasks                 → 创建任务 {title, context, verify}
 *   POST /api/tasks/:id/action      → claim/done/reopen/pause/archive
 *   POST /api/tasks/:id/dispatch    → 派发单个任务，返回 {ok, result, costUsage}
 *   POST /api/dispatch              → 派发全部 pending 任务
 *   POST /api/dispatch/:id          → 派发单个任务
 *   POST /api/dispatch/batch        → 并行派发 {taskIds:[...]} 或 {all:true}（并发上限 3）
 *   GET  /api/health                → 健康检查
 *
 * 成本台账契约：每次派发成功后由 server 端把执行记录追加到 data/ledger.json，
 * 每项 {taskId, title, usage, durationMs, sessionId, at}，
 * usage 来自任务 JSON 的 costUsage 字段（Worker-1 runner 写入，{inputTokens,outputTokens,cacheHitTokens,cacheMissTokens,durationMs}）。
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overview, dispatchToReasonix, dispatchAllPending, engineConfig } from './core/orchestrator.js';
import { createTask, applyAction, getTask, listTasks } from './core/queue.js';
import { listConversations, getConversation, createConversation, appendMessage, buildContextPrompt } from './core/conversations.js';
import { runReasonixTask } from './engine/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');
const HOST = '127.0.0.1';
const PORT = Number(process.env.DEEPFUSION_PORT || 43210);
const DATA_DIR = path.join(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const BATCH_LIMIT = 3; // 并行派发并发上限

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function ok(res, obj) { sendJson(res, 200, obj); }
function fail(res, status, message) { sendJson(res, status, { ok: false, error: message }); }

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({ __parseError: true }); }
    });
    req.on('error', () => resolve({}));
  });
}

/* ---------------- 成本台账 ---------------- */

function readLedger() {
  try {
    if (!existsSync(LEDGER_FILE)) return [];
    const raw = JSON.parse(readFileSync(LEDGER_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function appendLedger(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const entries = readLedger();
    entries.push(entry);
    writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  } catch (e) { console.error('[ledger] 写入失败:', String(e.message || e)); }
}

/** 由派发成功后的任务构造台账记录 */
function ledgerEntryFromTask(task) {
  const usage = (task && task.costUsage) || null;
  return {
    taskId: task ? task.id : null,
    title: task ? (task.title || '') : '',
    usage,
    durationMs: usage && typeof usage.durationMs === 'number' ? usage.durationMs : null,
    sessionId: null,
    at: new Date().toISOString()
  };
}

/** 派发成功则追加台账记录 */
function recordDispatch(r) {
  if (r && r.ok && r.task) appendLedger(ledgerEntryFromTask(r.task));
}

/** 并行派发：并发上限 BATCH_LIMIT，结果保持入参顺序 */
async function dispatchBatch(taskIds, opts = {}) {
  const ids = Array.isArray(taskIds) ? [...taskIds] : [];
  const results = new Array(ids.length);
  const limit = Math.max(1, Math.min(BATCH_LIMIT, ids.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const idx = cursor++;
      const id = ids[idx];
      let r;
      try {
        r = await dispatchToReasonix(id, opts);
      } catch (e) {
        r = { ok: false, error: String(e.message || e) };
      }
      recordDispatch(r);
      results[idx] = r.ok
        ? { id, ok: true, costUsage: (r.task && r.task.costUsage) || null }
        : { id, ok: false, error: r.error || '派发失败' };
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/* ---------------- 静态资源 ---------------- */

async function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(WEB_DIR, p);
  if (!file.startsWith(WEB_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    sendJson(res, 404, { ok: false, error: 'not found: ' + urlPath });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const p = url.pathname;
  const method = req.method;

  try {
    // 健康检查
    if (method === 'GET' && p === '/api/health') return ok(res, { ok: true, name: 'deepfusion', time: new Date().toISOString() });

    // 总览（附带端口，供前端设置卡展示）
    if (method === 'GET' && p === '/api/overview') return ok(res, { ...overview(), port: PORT });

    // 引擎详情（附带端口）
    if (method === 'GET' && p === '/api/engine') return ok(res, { ...engineConfig(), port: PORT });

    // 成本台账
    if (method === 'GET' && p === '/api/ledger') return ok(res, { ok: true, entries: readLedger() });

    // 对话列表
    if (method === 'GET' && p === '/api/conversations') return ok(res, { ok: true, conversations: listConversations() });

    // 对话详情
    let cm = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (method === 'GET' && cm) {
      const c = getConversation(cm[1]);
      if (!c) return fail(res, 404, '对话不存在');
      return ok(res, { ok: true, conversation: c });
    }

    // 发消息（对话）
    if (method === 'POST' && p === '/api/chat') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      if (!body.message || !String(body.message).trim()) return fail(res, 400, '缺少 message');
      const message = String(body.message).trim();
      const conv = body.conversationId ? getConversation(body.conversationId) : null;
      const c = conv || createConversation(message.slice(0, 30));
      appendMessage(c, 'user', message);
      const prompt = buildContextPrompt(c, message);
      const r = await runReasonixTask({
        prompt,
        model: body.model || 'deepseek-chat',
        timeoutMs: 180000
      });
      if (!r.ok) {
        appendMessage(c, 'assistant', '（调用失败：' + (r.error || '未知错误') + '）');
        return ok(res, { ok: false, error: r.error, conversation: c });
      }
      appendMessage(c, 'assistant', r.text || '（空回复）', r.usage || null);
      return ok(res, { ok: true, conversation: c, reply: r.text, usage: r.usage, durationMs: r.durationMs });
    }

    // 删除对话
    cm = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (method === 'DELETE' && cm) {
      // 简单实现：置空标题并保留（或直接删文件）
      const { rmSync } = await import('node:fs');
      const c = getConversation(cm[1]);
      if (!c) return fail(res, 404, '对话不存在');
      try { rmSync(path.join(process.cwd(), 'data', 'conversations', cm[1] + '.json')); } catch {}
      return ok(res, { ok: true });
    }

    // 创建任务
    if (method === 'POST' && p === '/api/tasks') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      if (!body.title) return fail(res, 400, '缺少 title');
      const task = createTask({ title: body.title, context: body.context, verify: body.verify });
      return ok(res, { ok: true, task });
    }

    // 任务动作
    let m = p.match(/^\/api\/tasks\/([^/]+)\/action$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      const task = getTask(m[1]);
      if (!task) return fail(res, 404, '任务不存在');
      const r = applyAction(task, body.action, body);
      return r.ok ? ok(res, r) : fail(res, 400, r.error);
    }

    // 派发单个任务（新契约：{ok, result, costUsage}，成功后写台账）
    m = p.match(/^\/api\/tasks\/([^/]+)\/dispatch$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      const r = await dispatchToReasonix(m[1], body);
      recordDispatch(r);
      if (!r.ok) return fail(res, 400, r.error);
      return ok(res, { ok: true, result: r.task, costUsage: (r.task && r.task.costUsage) || null });
    }

    // 并行派发：{taskIds:[...]} 或 {all:true}（全部 pending），并发上限 3
    if (method === 'POST' && p === '/api/dispatch/batch') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      let ids = Array.isArray(body.taskIds) ? body.taskIds : null;
      if (!ids || !ids.length) {
        if (body.all) ids = listTasks().filter(t => t.status === 'pending').map(t => t.id);
        else return fail(res, 400, '缺少 taskIds 或 all:true');
      }
      const results = await dispatchBatch(ids, body);
      return ok(res, { ok: true, results });
    }

    // 派发单个任务（兼容旧路由）
    m = p.match(/^\/api\/dispatch\/([^/]+)$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      const r = await dispatchToReasonix(m[1], body);
      recordDispatch(r);
      return r.ok ? ok(res, r) : fail(res, 400, r.error);
    }

    // 派发全部 pending
    if (method === 'POST' && p === '/api/dispatch') {
      const body = await readBody(req);
      const r = await dispatchAllPending(body);
      for (const item of r) recordDispatch(item);
      return ok(res, { ok: true, results: r });
    }

    // 静态
    if (method === 'GET') return serveStatic(res, p);
    return fail(res, 405, 'method not allowed');
  } catch (e) {
    return fail(res, 500, String(e.message || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log('DeepFusion 工作台已启动: http://' + HOST + ':' + PORT);
});