/**
 * test-runner.js — runner.js（reasonix run --events-jsonl）实测
 *
 * 运行：DEEPSEEK_API_KEY=<key> node src/test-runner.js
 * 断言：ok=true 且 usage.cache_miss_tokens>0
 */
import { runReasonixTask, cacheHitRate } from './engine/runner.js';
import { detectReasonix } from './engine/manager.js';

const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.A1233_API_KEY;
if (!API_KEY) {
  console.log('未找到 DeepSeek API key（需要 DEEPSEEK_API_KEY 或 A1233_API_KEY 环境变量）');
  process.exit(1);
}

// 自动检测 reasonix（优先完整 .cmd 路径，与 test-acp.js 一致）
const detected = detectReasonix();
const chosen = detected.find(d => /\.cmd$/.test(d.bin)) || detected[0];
if (!chosen) {
  console.log('未检测到 reasonix，先执行: npm i -g reasonix');
  process.exit(1);
}
console.log('使用引擎: ' + chosen.bin + ' (' + chosen.source + ')');

const result = await runReasonixTask({
  prompt: '用一句话回答：你是谁？',
  cwd: process.cwd(),
  model: 'deepseek-chat',
  bin: chosen.bin,
  timeoutMs: 120000,
  onEvent: (ev) => { /* 静默收集，最后汇总 */ }
});

const usage = result.usage || {};
const usageOk = Number(usage.cacheMissTokens) > 0;
const ok = result.ok === true && usageOk;

const output = {
  ok,
  text: (result.text || '').slice(0, 300),
  usage,
  cacheHitRate: cacheHitRate(usage) + '%',
  sessionId: result.sessionId,
  durationMs: result.durationMs,
  eventCount: result.events.length,
  error: result.error,
  stderr: (result.stderr || '').slice(-300)
};
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  console.log('\n=== 断言失败: ok=true 且 usage.cache_miss_tokens>0 ===');
  process.exit(1);
}
console.log('\n=== 断言通过: ok=true, cache_miss_tokens=' + usage.cacheMissTokens + ' ===');
