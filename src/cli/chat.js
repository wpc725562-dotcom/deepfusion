/**
 * deepfusion chat "问题" — 直接对话（reasonix 引擎）
 */
import { runReasonixTask } from '../engine/runner.js';
import { loadConfig } from '../core/config.js';
import { buildPromptWithSkills } from '../core/skills.js';

export async function chatCmd(args) {
  const question = args.join(' ');
  if (!question) {
    console.log('用法: deepfusion chat "你的问题"');
    return;
  }
  const cfg = loadConfig();
  console.log('💬 提问: ' + question);
  console.log('引擎: reasonix · 模型: ' + cfg.engine.model + '\n');
  const prompt = buildPromptWithSkills(question, cfg.skills?.dir, cfg.skills?.autoInject !== false);
  const r = await runReasonixTask({
    prompt,
    model: cfg.engine.model,
    timeoutMs: cfg.engine.timeoutMs
  });
  if (!r.ok) {
    console.log('❌ 调用失败: ' + (r.error || '未知错误'));
    return;
  }
  console.log(r.text || '（空回复）');
  const u = r.usage || {};
  console.log('');
  console.log('💰 in=' + (u.inputTokens||0) + ' out=' + (u.outputTokens||0) + ' cache=' + (u.cacheHitTokens||0) + ' · ' + Math.round((r.durationMs||0)/1000) + 's');
}