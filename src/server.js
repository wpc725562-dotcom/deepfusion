/**
 * server.js — DeepFusion Web 工作台（v0.3 四栏融合版）
 * 端口 43210，纯 Node 标准库
 *
 * API:
 *   GET  /                         → 前端页面
 *   GET  /api/health               → 健康检查
 *   GET  /api/overview             → 引擎状态 + 任务统计 + 任务列表 + 端口
 *   GET  /api/engine               → reasonix 引擎检测详情
 *   GET  /api/models               → 可用模型列表
 *   GET  /api/ledger               → 成本台账
 *   GET  /api/account              → 账户余额 / 当日消耗 / 计费状态
 *   GET  /api/usage/context        → 上下文占用（环形面板）
 *   GET  /api/session/metrics      → 会话指标（平均耗时/费用/时长/请求数/命中率）
 *   GET  /api/usage/breakdown      → token 构成拆解
 *   GET  /api/conversations        → 对话列表（含分组/置顶）
 *   GET  /api/conversations/:id    → 对话详情
 *   POST /api/chat                 → 对话（一次性返回，兼容旧版）
 *   POST /api/chat/stream          → 对话（SSE 流式：think/code/text/usage/context/run_done）
 *   DELETE /api/conversations/:id  → 删除对话
 *   POST /api/tasks / action / dispatch / batch → 任务队列
 *   POST /api/dispatch             → 派发全部 pending
 *
 * 流式协议（POST /api/chat/stream，text/event-stream）：
 *   event: turn_started   data: {"runId","mode","conversationId"}
 *   event: text           data: {"text":"增量"}          —— 最终回复/思考/代码 原始增量
 *   event: phase          data: {"phase":"thinking|acting|streaming"}
 *   event: usage          data: {"usage":{inputTokens,outputTokens,cacheHitTokens,cacheMissTokens}}
 *   event: context        data: {"rawTokens","compressedTokens","ratio","pct","warn"}
 *   event: run_done       data: {"ok","durationMs","text"}
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overview, dispatchToReasonix, dispatchAllPending, engineConfig } from './core/orchestrator.js';
import { createTask, applyAction, getTask, listTasks } from './core/queue.js';
import { listConversations, getConversation, createConversation, appendMessage, buildContextPrompt } from './core/conversations.js';
import { runReasonixTask } from './engine/runner.js';
import { createGoal, getGoal, listGoals, resumeGoal } from './core/goals.js';
import { createOrchestration, getOrchestration, listOrchestrations } from './core/orchestration.js';
import { createJob, getJob, listJobs, killJob } from './core/jobs.js';
import { createTunnelService } from './dshtunnel/index.js';
import * as pocketSettings from './dshtunnel/index.js';
import { CONFIG_DIR } from './core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');
const HOST = '127.0.0.1';
let PORT = Number(process.env.DEEPFUSION_PORT || 43210);
const DATA_DIR = path.join(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json');
const BATCH_LIMIT = 3;
let pocketService = null;
const MODELS = ['tokenrhythm/deepseek-v4-flash', 'tokenrhythm/deepseek-v4-pro', 'tokenrhythm/glm-5.2', 'tokenrhythm/kimi-k2.5', 'tokenrhythm/qwen3.7-max'];
const DEFAULT_MODEL = 'tokenrhythm/deepseek-v4-flash'; // 可用且有计费的 provider

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

function recordDispatch(r) {
  if (r && r.ok && r.task) appendLedger(ledgerEntryFromTask(r.task));
}

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

/* ---------------- 用量 / 账户统计 ---------------- */

/** 从台账聚合会话指标 */
function aggregateMetrics() {
  const entries = readLedger();
  const usageList = entries.map(e => e.usage).filter(Boolean);
  const totalTokens = usageList.reduce((s, u) => s + (u.inputTokens || 0) + (u.cacheHitTokens || 0) + (u.cacheMissTokens || 0) + (u.outputTokens || 0), 0);
  const cacheHits = usageList.reduce((s, u) => s + (u.cacheHitTokens || 0), 0);
  const promptTokens = usageList.reduce((s, u) => s + (u.cacheHitTokens || 0) + (u.cacheMissTokens || 0), 0);
  const durations = entries.map(e => e.durationMs).filter(d => typeof d === 'number');
  const recent = durations.slice(-20);
  const avgHitMs = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : 0;
  return {
    requests: entries.length,
    totalTokens,
    totalCost: totalTokens * 0.000001,          // 估算：每百万 token ~1 元（前端展示用，以后端为准）
    runSeconds: Math.round(durations.reduce((a, b) => a + b, 0) / 1000),
    avgHitMs,
    cacheHitRate: promptTokens > 0 ? Math.round((cacheHits / promptTokens) * 10000) / 100 : 0
  };
}

/** 上下文占用估算（最近对话消息量 → token 粗估：1 汉字 ≈ 1 token） */
function estimateContext() {
  const convs = listConversations();
  const recent = convs.slice(0, 1)[0];
  let raw = 0;
  if (recent) {
    const c = getConversation(recent.id);
    raw = (c?.messages || []).reduce((s, m) => s + String(m.content || '').length, 0);
  }
  const rawTokens = raw;                                  // 中文 1 字 ≈ 1 token 粗估
  const compressedTokens = Math.round(rawTokens * 0.55);  // 估算压缩后（55%）
  const limit = 200000;                                   // tokenrhythm 上下文上限
  const pct = Math.min(100, Math.round((compressedTokens / limit) * 100));
  return {
    rawTokens, compressedTokens,
    ratio: rawTokens > 0 ? Math.round((compressedTokens / rawTokens) * 1000) / 1000 : 0,
    pct, warn: pct > 80
  };
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

/* ---------------- SSE 流式对话 ---------------- */

async function handleStreamChat(req, res, body) {
  if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
  const message = String(body.message || '').trim();
  if (!message) return fail(res, 400, '缺少 message');
  const model = body.model || DEFAULT_MODEL;
  const mode = body.mode || 'normal';
  const conv = body.conversationId ? getConversation(body.conversationId) : null;
  const c = conv || createConversation(message.slice(0, 30));
  appendMessage(c, 'user', message);
  const prompt = buildContextPrompt(c, message);
  const runId = 'run_' + Date.now().toString(36);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event, data) => {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch {}
  };

  send('turn_started', { runId, mode, conversationId: c.id });

  let phase = 'thinking';
  const r = await runReasonixTask({
    prompt,
    model,
    timeoutMs: 180000,
    streamJson: true,   // stream-json 模式：text 事件带正文增量
    onEvent: (ev) => {
      const kind = ev?.kind || ev?.type || '';
      if (kind === 'turn_phase') {
        phase = ev?.phase || phase;
        send('phase', { phase });
      }
      if (kind === 'stream_attempt') send('phase', { phase: 'streaming' });
      if (kind === 'text') {
        const t = ev?.text ?? ev?.delta ?? ev?.content ?? '';
        if (typeof t === 'string' && t) send('text', { text: t });
      }
      if (kind === 'usage' && ev?.usage) send('usage', { usage: ev.usage });
    }
  });

  // 最终 usage + 上下文 + 完成
  send('usage', { usage: r.usage });
  send('context', estimateContext());
  send('run_done', { ok: r.ok, durationMs: r.durationMs, text: r.text || '', error: r.error || null });

  if (r.ok) appendMessage(c, 'assistant', r.text || '（空回复）', r.usage || null);
  else appendMessage(c, 'assistant', '（调用失败：' + (r.error || '未知错误') + '）');
  // 对话费用计入台账（右侧面板累计）
  appendLedger({
    taskId: c.id, title: '[chat] ' + c.title,
    usage: r.usage || null,
    durationMs: r.durationMs || null,
    sessionId: r.sessionId || null,
    at: new Date().toISOString()
  });
  res.end();
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const p = url.pathname;
  const method = req.method;

  try {
    if (p.startsWith('/api/pocket') && pocketService) return await handlePocketRpc(req, res, pocketService);
    if (method === 'GET' && p === '/api/health') return ok(res, { ok: true, name: 'deepfusion', time: new Date().toISOString() });
    if (method === 'GET' && p === '/api/overview') return ok(res, { ...overview(), port: PORT, models: MODELS });
    if (method === 'GET' && p === '/api/engine') return ok(res, { ...engineConfig(), port: PORT });
    if (method === 'GET' && p === '/api/models') return ok(res, { ok: true, models: MODELS });
    if (method === 'GET' && p === '/api/ledger') return ok(res, { ok: true, entries: readLedger() });
    if (method === 'GET' && p === '/api/account') {
      const m = aggregateMetrics();
      return ok(res, { ok: true, balance: null, todayCost: m.totalCost, billing: 'active', requests: m.requests });
    }
    if (method === 'GET' && p === '/api/usage/context') return ok(res, { ok: true, ...estimateContext() });
    if (method === 'GET' && p === '/api/session/metrics') return ok(res, { ok: true, ...aggregateMetrics() });
    if (method === 'GET' && p === '/api/usage/breakdown') {
      const m = aggregateMetrics();
      const entries = readLedger().slice(-10);
      return ok(res, {
        ok: true,
        prompt: Math.round(m.totalTokens * 0.72),
        completion: Math.round(m.totalTokens * 0.2),
        reasoning: Math.round(m.totalTokens * 0.05),
        other: Math.round(m.totalTokens * 0.03),
        detail: entries.map(e => ({ at: (e.at || '').slice(0, 16), title: e.title || e.taskId || '', cost: ((e.usage && ((e.usage.inputTokens||0) + (e.usage.outputTokens||0) + (e.usage.cacheHitTokens||0) + (e.usage.cacheMissTokens||0)) * 0.000001) || 0) }))
      });
    }

    // 对话列表（含分组字段：group = 'global' 或 'project:<name>'）
    if (method === 'GET' && p === '/api/conversations') {
      const convs = listConversations();
      return ok(res, { ok: true, conversations: convs, groups: ['global'] });
    }

    let cm = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (method === 'GET' && cm) {
      const c = getConversation(cm[1]);
      if (!c) return fail(res, 404, '对话不存在');
      return ok(res, { ok: true, conversation: c });
    }

    // 一次性对话（兼容）
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
        model: body.model || DEFAULT_MODEL,
        timeoutMs: 180000
      });
      if (!r.ok) {
        appendMessage(c, 'assistant', '（调用失败：' + (r.error || '未知错误') + '）');
        return ok(res, { ok: false, error: r.error, conversation: c });
      }
      appendMessage(c, 'assistant', r.text || '（空回复）', r.usage || null);
      appendLedger({
        taskId: c.id, title: '[chat] ' + c.title,
        usage: r.usage || null, durationMs: r.durationMs || null,
        sessionId: r.sessionId || null, at: new Date().toISOString()
      });
      return ok(res, { ok: true, conversation: c, reply: r.text, usage: r.usage, durationMs: r.durationMs });
    }

    // SSE 流式对话
    if (method === 'POST' && p === '/api/chat/stream') {
      const body = await readBody(req);
      return handleStreamChat(req, res, body);
    }

    // 删除对话
    cm = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (method === 'DELETE' && cm) {
      const { rmSync } = await import('node:fs');
      const c = getConversation(cm[1]);
      if (!c) return fail(res, 404, '对话不存在');
      try { rmSync(path.join(process.cwd(), 'data', 'conversations', cm[1] + '.json')); } catch {}
      return ok(res, { ok: true });
    }

    // 多代理目标
    if (method === 'GET' && p === '/api/goals') return ok(res, { ok: true, goals: listGoals() });

    let gm = p.match(/^\/api\/goals\/([^/]+)$/);
    if (method === 'GET' && gm) {
      const g = getGoal(gm[1]);
      if (!g) return fail(res, 404, '目标不存在');
      return ok(res, { ok: true, goal: g });
    }

    if (method === 'POST' && p === '/api/goals') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      if (!body.objective || !String(body.objective).trim()) return fail(res, 400, '缺少 objective');
      const r = await createGoal(String(body.objective).trim(), { deep: !!body.deep, concurrency: Number(body.concurrency) || 2 });
      return ok(res, { ok: true, goal: r });
    }

    // 目标续跑
    gm = p.match(/^\/api\/goals\/([^/]+)\/resume$/);
    if (method === 'POST' && gm) {
      try {
        const r = await resumeGoal(gm[1]);
        return ok(res, { ok: true, goal: r });
      } catch (e) { return fail(res, 400, String(e.message || e)); }
    }

    // 多编排模式
    if (method === 'GET' && p === '/api/orchestrations') return ok(res, { ok: true, orchestrations: listOrchestrations() });

    let om = p.match(/^\/api\/orchestrations\/([^/]+)$/);
    if (method === 'GET' && om) {
      const o = getOrchestration(om[1]);
      if (!o) return fail(res, 404, '编排不存在');
      return ok(res, { ok: true, orchestration: o });
    }

    if (method === 'POST' && p === '/api/orchestrate') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      if (!body.objective || !String(body.objective).trim()) return fail(res, 400, '缺少 objective');
      try {
        const r = await createOrchestration({
          mode: body.mode || 'fanout',
          objective: String(body.objective).trim(),
          concurrency: Number(body.concurrency) || 2,
          reviewers: Number(body.reviewers) || 3,
          rounds: Number(body.rounds) || 1,
          deep: !!body.deep
        });
        return ok(res, { ok: true, orchestration: r });
      } catch (e) { return fail(res, 400, String(e.message || e)); }
    }

    // 后台任务管理
    if (method === 'GET' && p === '/api/jobs') return ok(res, { ok: true, jobs: listJobs() });

    let jm = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (method === 'GET' && jm) {
      const j = getJob(jm[1]);
      if (!j) return fail(res, 404, '任务不存在');
      return ok(res, { ok: true, job: j });
    }

    if (method === 'POST' && p === '/api/jobs') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      if (!body.title) return fail(res, 400, '缺少 title');
      const j = createJob({ title: body.title, type: body.type || 'async' });
      return ok(res, { ok: true, job: j });
    }

    jm = p.match(/^\/api\/jobs\/([^/]+)\/kill$/);
    if (method === 'POST' && jm) {
      try {
        const j = killJob(jm[1]);
        return ok(res, { ok: true, job: j });
      } catch (e) { return fail(res, 400, String(e.message || e)); }
    }

    // 创建任务
    if (method === 'POST' && p === '/api/tasks') {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      if (!body.title) return fail(res, 400, '缺少 title');
      const task = createTask({ title: body.title, context: body.context, verify: body.verify });
      return ok(res, { ok: true, task });
    }

    let m = p.match(/^\/api\/tasks\/([^/]+)\/action$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      const task = getTask(m[1]);
      if (!task) return fail(res, 404, '任务不存在');
      const r = applyAction(task, body.action, body);
      return r.ok ? ok(res, r) : fail(res, 400, r.error);
    }

    m = p.match(/^\/api\/tasks\/([^/]+)\/dispatch$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      if (body.__parseError) return fail(res, 400, 'body 不是合法 JSON');
      const r = await dispatchToReasonix(m[1], body);
      recordDispatch(r);
      if (!r.ok) return fail(res, 400, r.error);
      return ok(res, { ok: true, result: r.task, costUsage: (r.task && r.task.costUsage) || null });
    }

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

    m = p.match(/^\/api\/dispatch\/([^/]+)$/);
    if (method === 'POST' && m) {
      const body = await readBody(req);
      const r = await dispatchToReasonix(m[1], body);
      recordDispatch(r);
      return r.ok ? ok(res, r) : fail(res, 400, r.error);
    }

    if (method === 'POST' && p === '/api/dispatch') {
      const body = await readBody(req);
      const r = await dispatchAllPending(body);
      for (const item of r) recordDispatch(item);
      return ok(res, { ok: true, results: r });
    }

    if (method === 'GET') return serveStatic(res, p);
    return fail(res, 405, 'method not allowed');
  } catch (e) {
    return fail(res, 500, String(e.message || e));
  }
});

/** 检测端口是否被占用 */
function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, HOST);
  });
}

async function startServer() {
  // 检查端口占用
  if (await portInUse(PORT)) {
    console.error('[server] 端口 ' + PORT + ' 已被占用，尝试端口 ' + (PORT + 1));
    PORT = PORT + 1;
  }

  server.listen(PORT, HOST, async () => {
    console.log('DeepFusion 工作台已启动: http://' + HOST + ':' + PORT);
    // 启动手机访问服务
    try {
      const pocketPort = Number(process.env.DEEPFUSION_POCKET_PORT || 3082);
      const tunnelService = createTunnelService({ dshPort: PORT, port: pocketPort, home: CONFIG_DIR });
      await tunnelService.startProxy();
      console.log('📱 dshtunnel 局域网代理已就绪（端口 ' + pocketPort + '）');
      tunnelService.restoreTunnelIfNeeded().catch(() => {});
      pocketService = tunnelService;
      // 进程退出清理
      const cleanup = () => { tunnelService.dispose().catch(() => {}); };
      process.on('SIGINT', cleanup);
      process.on('exit', cleanup);
    } catch (e) {
      console.warn('⚠️  dshtunnel 启动失败:', e.message);
    }
  });
}

startServer().catch(e => {
  console.error('[server] 启动失败:', e.message || e);
  process.exit(1);
});


/** 手机访问 API RPC（仅 loopback 可调，无认证风险） */
async function handlePocketRpc(req, res, service) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;
  const home = CONFIG_DIR;
  function ok(data) { return sendJson(res, 200, { ok: true, ...data }); }
  function fail(msg) { return sendJson(res, 400, { ok: false, error: msg }); }
  function readBody() { return new Promise((res2) => { let raw = ''; req.on('data', d => { raw += d; if (raw.length > 65536) req.destroy(); }); req.on('end', () => { try { res2(raw ? JSON.parse(raw) : {}); } catch { res2({}); } }); req.on('error', () => res2({})); }); }

  if (method === 'GET' && p === '/api/pocket/status') {
    const st = await service.status();
    return ok({
      ...st,
      accessToken: pocketSettings.getPublicPin(home),
      lanToken: pocketSettings.getLanPin(home),
      lanAuthEnabled: pocketSettings.lanAuthEnabled(home),
      publicPinCustom: pocketSettings.pinCustom(home, 'public'),
      lanPinCustom: pocketSettings.pinCustom(home, 'lan'),
      port: Number(process.env.DEEPFUSION_POCKET_PORT || 3082),
    });
  }
  if (method === 'POST' && p === '/api/pocket/lan/auth') {
    const body = await readBody();
    pocketSettings.setLanAuthEnabled(home, body.on === true);
    return ok({ lanAuthEnabled: pocketSettings.lanAuthEnabled(home) });
  }
  if (method === 'POST' && p === '/api/pocket/lan/pin/refresh') {
    const fresh = pocketSettings.refreshLanPin(home);
    return ok({ lanToken: fresh });
  }
  if (method === 'POST' && p === '/api/pocket/lan/ip') {
    try { pocketSettings.setLanIpOverride(home, (await readBody()).ip || ''); } catch (e) { return fail(e.message); }
    const st = await service.status();
    return ok({ ...st });
  }
  if (method === 'POST' && p === '/api/pocket/pin/custom') {
    const body = await readBody();
    const which = body.which === 'public' || body.which === 'lan' ? body.which : null;
    if (!which) return fail('未知密码类型');
    try { pocketSettings.writePin(home, which, body.value); } catch (e) { return fail(e.message); }
    pocketSettings.setPinCustom(home, which, true);
    return ok({ which, pin: String(body.value || ''), custom: true });
  }
  if (method === 'POST' && p === '/api/pocket/tunnel/start') {
    const body = await readBody();
    if (body.disclaimer !== true) return fail('请先阅读并勾选安全免责声明 | please accept the security disclaimer');
    await service.startTunnel();
    const st = await service.status();
    return ok({ ...st, accessToken: pocketSettings.getPublicPin(home) });
  }
  if (method === 'POST' && p === '/api/pocket/tunnel/stop') {
    service.stopTunnel();
    const st = await service.status();
    return ok({ ...st });
  }
  if (method === 'GET' && p === '/api/pocket/tunnel/config') {
    return ok({ config: pocketSettings.tunnelConfig(home) });
  }
  if (method === 'POST' && p === '/api/pocket/tunnel/config') {
    const body = await readBody();
    try { pocketSettings.saveTunnelConfig(home, body); } catch (e) { return fail(e.message); }
    return ok({ config: pocketSettings.tunnelConfig(home) });
  }
  return fail('unknown pocket endpoint: ' + p);
}
