/**
 * goals.js — 多代理调度：总指挥拆解 + 子代理池并行执行 + 结果汇总
 *
 * 流程：
 *   1. 总指挥 Agent（一次 reasonix run）把目标拆解为 N 个可独立执行的子任务
 *   2. 子代理池（并发 ≤ concurrency）各自执行一个子任务（独立 reasonix run）
 *   3. 汇总所有子代理结果，标记 goal 完成
 *
 * goal 结构：
 *   { id, objective, deep, status, phase, steps[], doneCount, totalCount,
 *     usage, createdAt, error }
 */
import { runReasonixTask } from '../engine/runner.js';
import { resolveModel } from './config.js';

const goals = new Map();   // id -> goal

export function listGoals() {
  return [...goals.values()].map(g => ({
    id: g.id, objective: g.objective, status: g.status, phase: g.phase,
    doneCount: g.doneCount, totalCount: g.totalCount, createdAt: g.createdAt,
    error: g.error || null
  }));
}

export function getGoal(id) { return goals.get(id) || null; }

export async function createGoal(objective, { deep = false, concurrency = 2 } = {}) {
  const id = 'goal-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const goal = {
    id, objective, deep, status: 'running', phase: 'decomposing',
    steps: [], doneCount: 0, totalCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cost: 0 },
    createdAt: new Date().toISOString(), error: null
  };
  goals.set(id, goal);
  // 后台异步执行（不阻塞请求）
  runGoal(goal, concurrency).catch((e) => {
    goal.status = 'failed'; goal.error = String(e.message || e);
  });
  return { id, objective, status: goal.status, phase: goal.phase };
}

/** 从总指挥输出中解析子任务数组（兼容 markdown 代码块包裹） */
function parseSteps(text) {
  const t = String(text || '');
  let arr = null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : t;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { arr = JSON.parse(candidate.slice(start, end + 1)); } catch {}
  }
  if (!arr) { try { arr = JSON.parse(t); } catch {} }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s, i) => ({ title: s?.title || s?.name || '子任务 ' + (i + 1), task: s?.task || s?.prompt || s?.description || s?.objective || '' }))
    .filter(s => s.task);
}

async function runGoal(goal, concurrency) {
  try {
        // ---- 1. 总指挥拆解 ----
    const decompose = await runReasonixTask({
      prompt: '你是总指挥 Agent。请把下面的目标拆解为最多 ' + (goal.deep ? 6 : 4) + ' 个可独立执行的子任务（每个子任务必须自包含、含背景、目标、验收标准，子代理拿到后能独立完成）。只输出 JSON 数组，格式：[{"title":"子任务标题","task":"给子智能体的完整指令"}]。不要输出任何其他文字。目标：' + (goal.objective || '').replace(/\n/g, ' '),
      model: resolveModel(), timeoutMs: 180000, streamJson: true
    });
        const steps = parseSteps(decompose.text);
    if (!steps.length) {
      // 拆解失败兜底：整包作为单个子任务
      steps.push({ title: '完整执行', task: goal.objective });
    }
    goal.steps = steps.map((s, i) => ({ id: 'step-' + (i + 1), title: s.title, task: s.task, status: 'queued', result: null, usage: null, error: null }));
    goal.totalCount = steps.length;
    goal.phase = 'executing';

    // ---- 2. 子代理池并行执行 ----
    let cursor = 0;
    const worker = async () => {
      while (cursor < goal.steps.length) {
        const idx = cursor++;
        const step = goal.steps[idx];
        step.status = 'running';
        try {
          const r = await runReasonixTask({ prompt: step.task, model: resolveModel(), timeoutMs: 240000, streamJson: true });
          step.status = r.ok ? 'done' : 'failed';
          step.result = r.text || '';
          step.usage = r.usage || {};
          step.error = r.error || null;
        } catch (e) {
          step.status = 'failed'; step.error = String(e.message || e);
        }
        goal.doneCount++;
        const u = step.usage || {};
        goal.usage.inputTokens += u.inputTokens || 0;
        goal.usage.outputTokens += u.outputTokens || 0;
        goal.usage.cacheHitTokens += u.cacheHitTokens || 0;
        goal.usage.cacheMissTokens += u.cacheMissTokens || 0;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 3)) }, () => worker()));

    // ---- 3. 汇总 ----
    const done = goal.steps.filter(s => s.status === 'done');
    const failed = goal.steps.filter(s => s.status === 'failed');
    const summary = done.length + ' / ' + goal.totalCount + ' 个子任务完成';
    goal.summary = summary;
    goal.status = failed.length === goal.totalCount ? 'failed' : 'done';
    goal.phase = 'done';
  } catch (e) {
    goal.status = 'failed'; goal.error = String(e.message || e);
  }
}/** goals.js 增强：resume 续跑 + 衰减式熔断 + revision 状态机 */

/* ---------------- 续跑 ---------------- */
export async function resumeGoal(goalId) {
  const goal = goals.get(goalId);
  if (!goal) throw new Error('目标不存在: ' + goalId);
  if (goal.status !== 'failed' && goal.status !== 'blocked') throw new Error('只有 failed/blocked 状态可续跑，当前: ' + goal.status);
  goal.revision = (goal.revision || 1) + 1;
  goal.roundsStarted = (goal.roundsStarted || 0) + 1;
  goal.status = 'running'; goal.phase = 'decomposing';
  goal.error = null; goal.blocked = null;
  goal.steps = []; goal.doneCount = 0; goal.totalCount = 0;
  runGoal(goal, goal.concurrency || 2).catch((e) => {
    if (Array.isArray(goal.recentErrors) && goal.recentErrors.length >= 3) {
      const last = goal.recentErrors.slice(-3);
      if (last[0] === last[1] && last[1] === last[2]) {
        goal.status = 'blocked'; goal.blocked = '连续 3 轮同因失败，标记为 blocked';
      }
    }
    if (goal.status !== 'blocked') { goal.status = 'failed'; goal.error = String(e.message || e); }
  });
  return { id: goal.id, revision: goal.revision, status: goal.status };
}
