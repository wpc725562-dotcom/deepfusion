/**
 * orchestrator.js — 融合编排器
 * 指挥官逻辑：任务队列 → Reasonix 引擎（run --events-jsonl）执行 → 结果回收
 * 
 * 这是 DSH 式编排 × Reasonix 式执行的融合点：
 * - 编排/状态机/队列 = DSH 哲学
 * - 实际编码执行 = Reasonix 引擎（前缀缓存优化，run 模式 + usage 成本解析）
 * - ACP 客户端保留在 engine/reasonix.js（ACP 备用），此处走 runner.js
 */
import { runReasonixTask, cacheHitRate } from '../engine/runner.js';
import { listTasks, getTask, applyAction, createTask, taskStats } from './queue.js';
import { engineStatus, resolveLaunch, loadConfig } from '../engine/manager.js';
import { runConcurrent } from './dispatcher.js';

/** 引擎执行配置 */
export function engineConfig() {
  const st = engineStatus();
  const launch = resolveLaunch(st);
  return {
    usable: !!launch,
    launch,
    model: loadConfig().model || process.env.REASONIX_MODEL || 'deepseek-pro',
    status: st
  };
}

/** 派发一个任务给 reasonix 引擎执行（同步等待结果并回写） */
export async function dispatchToReasonix(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: '任务不存在: ' + taskId };

  const cfg = engineConfig();
  if (!cfg.usable) {
    return { ok: false, error: 'reasonix 引擎不可用：' + (cfg.status.hint || '未检测到引擎') };
  }

  // 标记 assigned（若还 pending）
  if (task.status === 'pending') applyAction(task, 'claim', { owner: 'reasonix' });

  const prompt = buildTaskPrompt(task);
  const events = [];
  const result = await runReasonixTask({
    prompt,
    cwd: opts.cwd || process.env.DEEPFUSION_WORKSPACE || process.cwd(),
    model: opts.model || cfg.model,
    bin: cfg.launch.bin,
    timeoutMs: opts.timeoutMs || 600000,
    onEvent: (e) => { events.push(e); }
  });

  // 回收：根据执行结果写回任务
  if (result.error) {
    applyAction(task, 'reopen');
    return { ok: false, error: result.error, events };
  }
  const text = String(result.text || '');
  const usage = result.usage || {};
  const hitRate = cacheHitRate(usage);
  // 成本信息写进任务 JSON 新字段 costUsage
  task.costUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
    durationMs: result.durationMs
  };
  applyAction(task, 'done', {
    result: text.slice(0, 2000),
    verifyResult: `engine=reasonix status=done text_len=${text.length} session=${result.sessionId || '-'} duration_ms=${result.durationMs ?? '-'} cache_hit_rate=${hitRate}%`
  });
  return { ok: true, task: getTask(taskId), events, usage: task.costUsage };
}

/** 构造任务提示词（DSH 式任务文件 → Reasonix 可执行指令） */
export function buildTaskPrompt(task) {
  const parts = [];
  if (task.title) parts.push('## 任务标题\n' + task.title);
  if (task.context) parts.push('## 任务说明\n' + task.context);
  if (task.verify) parts.push('## 验收要求\n' + task.verify);
  parts.push('## 执行要求\n请直接完成上述任务。完成后用中文简洁总结：做了什么、产出文件路径。');
  return parts.join('\n\n');
}

/** 批量派发：队列中所有 pending 任务并发执行（默认并发 2，可用 opts.concurrency 调整） */
export async function dispatchAllPending(opts = {}) {
  const tasks = listTasks().filter(t => t.status === 'pending');
  const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 2;
  return runConcurrent(tasks, async (t) => dispatchToReasonix(t.id, opts), concurrency);
}

/** 总览 */
export function overview() {
  const tasks = listTasks();
  return {
    engine: engineStatus(),
    stats: taskStats(tasks),
    tasks,
    timestamp: new Date().toISOString()
  };
}
