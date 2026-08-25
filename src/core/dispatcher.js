/**
 * dispatcher.js — 并发控制（通用 promise pool）
 *
 * 提供 runConcurrent（通用并发限流执行器）和 dispatchBatch（任务并行派发）。
 * 单个失败不阻断其他，全部完成后返回完整结果数组。
 */
import { dispatchToReasonix } from './orchestrator.js';

/**
 * 通用并发执行器：对 items 中的每个元素调用 worker(item, index)，
 * 限制并发数不超过 concurrency。全部完成后返回结果数组（保持顺序）。
 * 单个元素的 worker 抛出异常不会影响其他元素执行。
 *
 * @param {Array} items 待处理元素列表
 * @param {(item, index) => Promise} worker 每项的处理函数
 * @param {number} [concurrency=3] 并发上限
 * @returns {Promise<Array>} 结果数组，保持 items 顺序
 */
export async function runConcurrent(items, worker, concurrency = 3) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const results = new Array(list.length);
  const limit = Math.max(1, Math.min(concurrency, list.length));
  let cursor = 0;

  async function runner() {
    while (cursor < list.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(list[idx], idx);
      } catch (e) {
        results[idx] = { error: String((e && e.message) || e), ok: false };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

/**
 * 并行派发多个任务给 reasonix 引擎。
 * 调用 orchestrator.dispatchToReasonix 并发执行，单个失败不阻断其他。
 *
 * @param {string[]} taskIds 任务 ID 数组
 * @param {object} [opts] 额外选项，透传给 dispatchToReasonix
 * @param {number} [opts.concurrency=3] 并发上限
 * @returns {Promise<{results: Array<{id: string, ok: boolean, error?: string, costUsage?: object}>}>}
 */
export async function dispatchBatch(taskIds, opts = {}) {
  const ids = Array.isArray(taskIds) ? [...taskIds] : [];
  const concurrency = Number(opts.concurrency) || 3;
  const results = await runConcurrent(ids, async (id) => {
    try {
      const r = await dispatchToReasonix(id, opts);
      if (r && r.ok) return { id, ok: true, costUsage: (r.task && r.task.costUsage) || null };
      return { id, ok: false, error: (r && r.error) || '派发失败' };
    } catch (e) {
      return { id, ok: false, error: String((e && e.message) || e) };
    }
  }, concurrency);
  return { results };
}
