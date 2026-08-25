/** orchestration.js — DSH 式多编排模式引擎（DAG 调度近似）*/
import { runReasonixTask } from '../engine/runner.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
const MODEL = process.env.DEEPFUSION_MODEL || 'tokenrhythm/deepseek-v4-flash';
const ORCH_DIR = path.join(process.cwd(), 'data', 'orchestrations');
const MODES = ['fanout', 'pipeline', 'map-reduce', 'supervisor'];
function ensureDir() { mkdirSync(ORCH_DIR, { recursive: true }); }
function FD(id) { return path.join(ORCH_DIR, id + '.json'); }
function load(id) { const p = FD(id); if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function save(o) { ensureDir(); writeFileSync(FD(o.id), JSON.stringify(o, null, 2) + '\n', 'utf8'); }
export function listOrchestrations() {
  ensureDir();
  const list = [];
  for (const f of readdirSync(ORCH_DIR)) {
    if (!f.endsWith('.json')) continue;
    const o = load(f.slice(0, -5));
    if (o) list.push({
      id: o.id, mode: o.mode, objective: o.objective, status: o.status,
      phase: o.phase, doneCount: o.doneCount, totalCount: o.totalCount,
      createdAt: o.createdAt, updatedAt: o.updatedAt, revision: o.revision,
      error: o.error || null, blocked: o.blocked || null
    });
  }
  return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
export function getOrchestration(id) { return load(id); }
/* ---------------- 暂停/恢复/重置 ---------------- */
export function pauseOrchestration(id) {
  const o = load(id);
  if (!o) return null;
  if (o.status !== 'running' && o.status !== 'decomposing' && o.phase !== 'executing') return null;
  o.status = 'paused'; o.phase = 'paused';
  o.updatedAt = new Date().toISOString(); save(o);
  return { id: o.id, status: o.status, phase: o.phase };
}
export function resumeOrchestration(id) {
  const o = load(id);
  if (!o) return null;
  if (o.status !== 'paused') return null;
  o.status = 'running'; o.phase = 'executing';
  o.updatedAt = new Date().toISOString(); save(o);
  // 续跑：异步继续执行
  runOrchestration(o).catch((e) => { o.status = 'failed'; o.error = String(e.message || e); save(o); });
  return { id: o.id, status: o.status, phase: o.phase };
}
export function resetOrchestration(id) {
  const o = load(id);
  if (!o) return null;
  if (o.status !== 'blocked' && o.status !== 'failed') return null;
  o.status = 'running'; o.phase = 'decomposing';
  o.recentErrors = []; o.error = null; o.blocked = null;
  o.revision = (o.revision || 1) + 1;
  o.updatedAt = new Date().toISOString(); save(o);
  runOrchestration(o).catch((e) => { o.status = 'failed'; o.error = String(e.message || e); save(o); });
  return { id: o.id, status: o.status, phase: o.phase };
}
/* ---------------- 辅助：reasonix 调用 + 拆解 ---------------- */
function parseSteps(text) {
  const t = String(text || '');
  let arr = null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) { try { arr = JSON.parse(candidate.slice(start, end + 1)); } catch {} }
  if (!arr) { try { arr = JSON.parse(t); } catch {} }
  if (!Array.isArray(arr)) return [];
  return arr.map((s, i) => ({
    title: s?.title || s?.name || s?.stage || '步骤 ' + (i + 1),
    task: s?.task || s?.prompt || s?.description || s?.objective || ''
  })).filter(s => s.task);
}
async function ask(prompt, timeoutMs = 240000) {
  return runReasonixTask({ prompt, model: MODEL, timeoutMs, streamJson: true });
}
/* ---------------- 创建编排 ---------------- */
export async function createOrchestration({
  mode = 'fanout', objective: obj, concurrency = 2,
  reviewers = 3, rounds = 1, deep = false
} = {}) {
  if (!MODES.includes(mode)) throw new Error('不支持模式: ' + mode + '，可选 ' + MODES.join('/'));
  if (!obj || !String(obj).trim()) throw new Error('目标不能为空');
  const id = 'orch-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const orch = {
    id, mode, objective: String(obj).trim(),
    status: 'running', phase: 'decomposing', steps: [],
    doneCount: 0, totalCount: 0,
    concurrency: Math.max(1, Number(concurrency) || 2),
    reviewers: Math.max(1, Number(reviewers) || 3),
    rounds: Math.max(1, Number(rounds) || 1), deep: !!deep,
    revision: 1, roundsStarted: 0,
    result: null, summary: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
    recentErrors: [], error: null, blocked: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  save(orch);
  runOrchestration(orch).catch((e) => { orch.status = 'failed'; orch.error = String(e.message || e); save(orch); });
  return getOrchestration(orch.id);
}
/* ---------------- 熔断判定（连续 3 轮同因阻塞 → blocked） ---------------- */
function isBlocked(o) {
  if (!Array.isArray(o.recentErrors) || o.recentErrors.length < 3) return null;
  const last = o.recentErrors.slice(-3);
  if (last[0] && last[1] && last[2] && last[0] === last[1] && last[1] === last[2]) {
    return /超时|timeout|权限|permission|拒绝|denied/i.test(last[0]) ? last[0].slice(0, 150) : '连续 3 轮同因失败: ' + last[0].slice(0, 120);
  }
  return null;
}
function recordError(o, err) {
  const s = String(err || '');
  o.recentErrors.push(s.slice(0, 300));
  if (o.recentErrors.length > 6) o.recentErrors.splice(0, o.recentErrors.length - 6);
  o.error = s; o.updatedAt = new Date().toISOString();
  const b = isBlocked(o);
  if (b) { o.status = 'blocked'; o.blocked = b; o.phase = 'blocked'; }
  save(o);
  return !!b;
}
async function runOrchestration(o) {
  try {
    o.phase = 'decomposing'; o.recentErrors = []; save(o);
    if (o.mode === 'fanout') return await runFanout(o);
    if (o.mode === 'pipeline') return await runPipeline(o);
    if (o.mode === 'map-reduce') return await runMapReduce(o);
    if (o.mode === 'supervisor') return await runSupervisor(o);
  } catch (e) {
    if (recordError(o, e.message || e)) return;
    o.status = 'failed'; o.error = String(e.message || e); o.phase = 'failed'; save(o);
  }
}
async function decompose(o) {
  const maxSteps = o.deep ? 6 : 4;
  const r = await ask('你是编排总指挥 Agent。请把下面目标拆解为最多 ' + maxSteps + ' 个可独立执行的步骤（每个自包含，含背景/目标/验收标准）。只输出 JSON 数组：[{"title":"步骤标题","task":"指令"}]。只输出 JSON。目标：' + o.objective.replace(/\n/g, ' '), 180000);
  let steps = parseSteps(r.text);
  if (!steps.length) steps = [{ title: '完整执行', task: o.objective }];
  o.steps = steps.map((s, i) => ({ id: 'st-' + (i + 1), title: s.title, task: s.task, status: 'queued', result: null, usage: null, error: null }));
  o.totalCount = steps.length; save(o);
  return steps;
}
async function runSteps(o) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < o.steps.length) {
      // 检查暂停状态
      const current = load(o.id);
      if (current && current.status === 'paused') return;
      const idx = cursor++; const step = o.steps[idx];
      step.status = 'running'; o.updatedAt = new Date().toISOString(); save(o);
      try {
        const r = await ask(step.task);
        step.status = r.ok ? 'done' : 'failed';
        step.result = r.text || ''; step.usage = r.usage || {}; step.error = r.error || null;
      } catch (
e) { step.status = 'failed'; step.error = String(e.message || e); }
      o.doneCount++; const u = step.usage || {};
      o.usage.inputTokens += u.inputTokens || 0;
      o.usage.outputTokens += u.outputTokens || 0;
      o.usage.cacheHitTokens += u.cacheHitTokens || 0;
      o.usage.cacheMissTokens += u.cacheMissTokens || 0;
      o.updatedAt = new Date().toISOString(); save(o);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, 3)) }, () => worker()));
  return o.steps;
}
function jointSteps(o) {
  return o.steps.filter(s => s.status === 'done').map((s, i) => (i + 1) + '. ' + s.title + '\n' + s.result).join('\n\n');
}
function finish(o, status, result, summary) {
  o.status = status; o.phase = 'done';
  o.result = result || null; o.summary = summary || '';
  o.updatedAt = new Date().toISOString(); save(o);
  return o;
}
/* ================= 模式实现 ================= */
async function runFanout(o) {
  await decompose(o); o.phase = 'executing'; save(o);
  await runSteps(o);
  const done = o.steps.filter(s => s.status === 'done');
  const failed = o.steps.filter(s => s.status === 'failed');
  const summary = done.length + ' / ' + o.totalCount + ' 个子任务完成' + (failed.length ? '，失败 ' + failed.length + ' 个' : '');
  return finish(o, failed.length === o.totalCount ? 'failed' : 'done', done.map(s => '【' + s.title + '】\n' + s.result).join('\n\n'), summary);
}
async function runPipeline(o) {
  await decompose(o); o.phase = 'executing'; save(o);
  let ctx = o.objective; const outputs = [];
  const stepList = o.steps;
  for (const step of stepList) {
    // 检查暂停状态
    const current = load(o.id);
    if (current && current.status === 'paused') return finish(o, 'paused', o.result || '', '已暂停');
    step.status = 'running'; o.doneCount++; o.updatedAt = new Date().toISOString(); save(o);
    const idx = stepList.indexOf(step) + 1;
    const p = '【流水线阶段 ' + idx + '】' + step.title + '\n\n' + step.task + '\n\n【前一阶段输出作参考】\n' + ctx.slice(0, 4000);
    try {
      const r = await ask(p);
      step.status = r.ok ? 'done' : 'failed'; step.result = r.text || '';
      step.usage = r.usage || {}; step.error = r.error || null;
      ctx = r.text || ctx;
    } catch (e) { step.status = 'failed'; step.error = String(e.message || e); }
    outputs.push(idx + '. ' + step.title);
    const u = step.usage || {};
    o.usage.inputTokens += u.inputTokens || 0; o.usage.outputTokens += u.outputTokens || 0;
    o.usage.cacheHitTokens += u.cacheHitTokens || 0; o.usage.cacheMissTokens += u.cacheMissTokens || 0;
    o.updatedAt = new Date().toISOString(); save(o);
  }
  const failed = o.steps.filter(s => s.status === 'failed');
  return finish(o, failed.length ? 'failed' : 'done', outputs.join('\n') + '\n\n最终输出：\n' + ctx.slice(0, 3000), '流水线 ' + (o.totalCount - failed.length) + '/' + o.totalCount + ' 阶段完成');
}
async function runMapReduce(o) {
  await decompose(o); o.phase = 'executing'; save(o);
  await runSteps(o);
  const mapBlock = jointSteps(o);
  if (!mapBlock) return finish(o, 'failed', null, 'map 阶段全部失败');
  o.steps.push({ id: 'st-reduce', title: 'reduce 归约汇总', task: '汇总', status: 'running', result: null, usage: null, error: null });
  o.totalCount = o.steps.length; o.doneCount++; o.updatedAt = new Date().toISOString(); save(o);
  const p = '你是归约 Agent。请把下面这些子任务的结果整合成一份完整、连贯、去重的最终答案。\n\n' + mapBlock.slice(0, 8000);
  const rr = await ask(p);
  const rs = o.steps[o.steps.length - 1];
  rs.status = rr.ok ? 'done' : 'failed'; rs.result = rr.text || ''; rs.usage = rr.usage || {}; rs.error = rr.error || null;
  o.updatedAt = new Date().toISOString(); save(o);
  return finish(o, rr.ok ? 'done' : 'failed', rr.text || '', 'map ' + (o.doneCount - 1) + ' → reduce 归约完成');
}
async function runSupervisor(o) {
  o.phase = 'executing';
  const n = Math.min(o.reviewers, 3);
  const produce = await ask('你是生成 Agent。针对下面目标，从 ' + n + ' 个不同视角给出 ' + n + ' 个候选回答。每个候选自包含、结构清晰。用【候选1】...【候选' + n + '】格式输出。\n目标：' + o.objective.replace(/\n/g, ' '), 180000);
  const cands = extractCandidates(produce.text, n);
  o.steps = cands.map((c, i) => ({ id: 'st-c' + (i + 1), title: '候选 ' + (i + 1), task: c, status: 'done', result: c, usage: produce.usage || {}, error: null, score: null }));
  o.totalCount = cands.length + 1; o.doneCount = cands.length;
  const u = produce.usage || {};
  o.usage.inputTokens += u.inputTokens || 0; o.usage.outputTokens += u.outputTokens || 0;
  o.usage.cacheHitTokens += u.cacheHitTokens || 0; o.usage.cacheMissTokens += u.cacheMissTokens || 0;
  o.updatedAt = new Date().toISOString(); save(o);

  const rp = '你是评审 Agent。请对下面的候选逐项打分(1-10)，只输出 JSON 数组：[{"index":1,"score":7,"comment":"理由"},...]。\n\n' +
    cands.map((c, i) => '【候选' + (i + 1) + '】\n' + c.slice(0, 2000)).join('\n\n') + '\n\n原目标：' + o.objective.replace(/\n/g, ' ');
  const rv = await ask(rp, 180000);
  const reviews = parseReviews(rv.text, cands.length);
  reviews.forEach(rev => { const st = o.steps[rev.index - 1]; if (st) st.score = rev.score; });
  const best = reviews.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  o.steps.push({ id: 'st-merge', title: 'supervisor 合成',
    result: cands[(best.index - 1)] || '', usage: {}, error: null, score: best.score || 0 });
  o.doneCount = o.steps.length; o.updatedAt = new Date().toISOString(); save(o);
  return finish(o, 'done', cands[(best.index - 1)] || '', 'supervisor 选中最优候选（评分 ' + (best.score || 0) + '/10）');
}
function extractCandidates(text, n) {
  const s = String(text || ''); const cands = [];
  const re = /【候选(\d+)】\s*([\s\S]*?)(?=【候选\d+】|$)/g; let m;
  while ((m = re.exec(s)) && cands.length < n) { if (m[2] && m[2].trim()) cands.push(m[2].trim()); }
  if (!cands.length) {
    const parts = s.split(/\n?(?:候选|Candidate)[^\n]*\n/).map(p => p.trim()).filter(Boolean);
    for (const
p of parts) { cands.push(p); if (cands.length >= n) break; }
  }
  if (!cands.length) cands.push(s.slice(0, 1000) || '（无候选）');
  return cands.slice(0, n);
}
function parseReviews(text, count) {
  const t = String(text || ''); let arr = null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('['); const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) { try { arr = JSON.parse(candidate.slice(start, end + 1)); } catch {} }
  if (!arr) { try { arr = JSON.parse(t); } catch {} }
  if (!Array.isArray(arr)) return Array.from({ length: count }, (_, i) => ({ index: i + 1, score: 5, comment: '' }));
  return arr.slice(0, count).map(r => ({ index: Number(r?.index) || 1, score: Number(r?.score) || 5, comment: r?.comment || '' }));
}
