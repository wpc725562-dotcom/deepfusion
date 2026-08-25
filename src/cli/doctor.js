/**
 * deepfusion doctor — 系统诊断
 */
import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, loadConfig } from '../core/config.js';
import { detectReasonix } from '../engine/manager.js';
import { pluginList } from './plugin.js';

export async function doctorCmd() {
  const cfg = loadConfig();
  console.log('═══ DeepFusion 诊断 ═══');
  console.log('系统: ' + process.platform + ' ' + process.arch + ' · Node ' + process.version);
  console.log('配置目录: ' + CONFIG_DIR);

  // 引擎
  try {
    const engs = detectReasonix();
    if (engs && engs.length) {
      const top = engs[0];
      console.log('✅ 引擎: reasonix ' + (top.version || '') + ' (' + top.bin + ')');
      if (engs.length > 1) console.log('   候选: ' + engs.length + ' 个');
    } else {
      console.log('❌ 引擎: 未找到 reasonix（npm i -g reasonix）');
    }
  } catch (e) { console.log('❌ 引擎: ' + String(e.message).slice(0, 100)); }

  // 配置
  console.log('✅ 配置: ' + path.join(CONFIG_DIR, 'config.toml') + (existsSync(path.join(CONFIG_DIR, 'config.toml')) ? '' : '（默认值）'));
  console.log('   模型: ' + cfg.engine.model + ' · 权限模式: ' + cfg.permission?.mode + ' · 每日预算: ' + (cfg.budget?.dailyTokens || '无限'));

  // 插件
  const plugins = pluginList();
  console.log('✅ 插件: ' + plugins.length + ' 个 (' + (cfg.plugins?.enabled || []).length + ' 启用)');

  // 技能
  const skillsDir = path.join(CONFIG_DIR, 'skills');
  let skillCount = 0;
  if (existsSync(skillsDir)) { try { skillCount = readdirSync(skillsDir).filter(d => existsSync(path.join(skillsDir, d, 'SKILL.md'))).length; } catch {} }
  console.log((skillCount ? '✅' : 'ℹ️') + ' 技能: ' + skillCount + ' 个');

  // MCP
  console.log('✅ MCP: ' + (cfg.mcp?.servers?.length || 0) + ' 个服务器' + (cfg.mcp?.expose ? ' · 暴露:开' : ''));

  // 数据
  const dataDir = path.join(process.cwd(), 'data');
  console.log('ℹ️ 数据目录: ' + dataDir + (existsSync(dataDir) ? '' : '（未创建）'));
  console.log('═══ 诊断完成 ═══');
}