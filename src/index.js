#!/usr/bin/env node
/**
 * index.js — DeepFusion CLI 入口
 *   deepfusion web           启动 Web 工作台
 *   deepfusion chat "问题"   直接对话
 *   deepfusion run <taskId>  派发单个任务
 *   deepfusion dispatch      派发全部 pending
 *   deepfusion task add      添加任务
 *   deepfusion plugin list   插件管理
 *   deepfusion skill list    技能管理
 *   deepfusion mcp list      MCP 管理
 *   deepfusion config show   配置管理
 *   deepfusion session list  会话管理
 *   deepfusion ledger        成本台账
 *   deepfusion doctor        诊断
 *   deepfusion engine        引擎状态
 *   deepfusion detect        检测引擎
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { engineStatus, detectReasonix, loadConfig, saveConfig } from './engine/manager.js';
import { createTask, listTasks, applyAction, getTask } from './core/queue.js';
import { dispatchToReasonix, dispatchAllPending } from './core/orchestrator.js';
import { chatCmd } from './cli/chat.js';
import { pluginCmd } from './cli/plugin.js';
import { skillCmd } from './cli/skill.js';
import { mcpCmd } from './cli/mcp.js';
import { doctorCmd } from './cli/doctor.js';
import { sessionCmd } from './cli/session.js';
import { loadConfig as loadCfg, CONFIG_DIR, ensureDirs } from './core/config.js';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'web': {
      const { execSync } = await import('node:child_process');
      execSync('node src/server.js', { stdio: 'inherit' });
      break;
    }
    case 'engine': {
      console.log(JSON.stringify(engineStatus(), null, 2));
      break;
    }
    case 'detect': {
      console.log(JSON.stringify(detectReasonix(), null, 2));
      break;
    }
    case 'task': {
      const sub = args[0];
      if (sub === 'add') {
        const t = await createTask({ title: args[1] || 'CLI 任务', context: args.slice(2).join(' '), verify: null });
        console.log('创建: ' + t.id);
      } else if (sub === 'list') {
        const tasks = listTasks();
        console.log('任务 (' + tasks.length + '):');
        for (const t of tasks) {
          console.log('  ' + t.id + ' [' + t.status + '] ' + (t.title || '').slice(0, 40));
        }
      }
      break;
    }
    case 'run': {
      const id = args[0];
      if (!id) { console.log('用法: deepfusion run <taskId>'); break; }
      console.log('派发 ' + id + ' 给 reasonix 引擎…');
      const r = await dispatchToReasonix(id);
      if (r.ok) console.log('✅ 完成: ' + r.task.status + ' result=' + (r.task.result || '').slice(0, 100));
      else console.log('❌ 失败: ' + r.error);
      break;
    }
    case 'dispatch': {
      console.log('派发全部 pending…');
      const results = await dispatchAllPending();
      for (const r of results) {
        console.log((r.ok ? '✅' : '❌') + ' ' + (r.task?.id || r.error));
      }
      break;
    }
    case 'ledger': {
      try {
        const j = JSON.parse(readFileSync(path.join(process.cwd(), 'data', 'ledger.json'), 'utf8'));
        const entries = j.entries || [];
        let totalIn = 0, totalOut = 0, totalHit = 0;
        for (const e of entries) { totalIn += e.usage?.inputTokens || 0; totalOut += e.usage?.outputTokens || 0; totalHit += e.usage?.cacheHitTokens || 0; }
        console.log('成本台账: ' + entries.length + ' 条记录');
        console.log('总 input: ' + totalIn + ' · output: ' + totalOut + ' · cache 命中: ' + totalHit);
        for (const e of entries.slice(-10)) {
          console.log('  ' + (e.taskId || '').slice(0, 16) + ' · ' + (e.title || '').slice(0, 20) + ' · in=' + (e.usage?.inputTokens||0) + ' out=' + (e.usage?.outputTokens||0) + ' · ' + Math.round((e.durationMs||0)/1000) + 's');
        }
      } catch { console.log('（无台账数据）'); }
      break;
    }
    case 'chat': { await chatCmd(process.argv.slice(3)); break; }
    case 'plugin': { await pluginCmd(process.argv.slice(3)); break; }
    case 'skill': { await skillCmd(process.argv.slice(3)); break; }
    case 'mcp': { await mcpCmd(process.argv.slice(3)); break; }
    case 'doctor': { await doctorCmd(); break; }
    case 'session': { await sessionCmd(process.argv.slice(3)); break; }
    case 'config': {
      const cfg = loadCfg();
      ensureDirs();
      const sub = process.argv[3];
      if (sub === 'show') { console.log(JSON.stringify(cfg, null, 2)); }
      else if (sub === 'dir') { console.log(CONFIG_DIR); }
      else if (sub === 'init') { console.log('配置目录: ' + CONFIG_DIR + '（默认配置自动生效）'); }
      else { console.log('用法: deepfusion config show | dir | init'); }
      break;
    }
    default: {
      console.log('DeepFusion CLI');
      console.log('用法:');
      console.log('  web             启动 Web 工作台');
      console.log('  chat <问题>     直接对话 (reasonix)');
      console.log('  run <taskId>    派发任务');
      console.log('  dispatch        派发全部 pending');
      console.log('  task add/list   任务队列');
      console.log('  plugin          插件管理');
      console.log('  skill           技能管理');
      console.log('  mcp             MCP 管理');
      console.log('  config          配置管理');
      console.log('  session         会话管理');
      console.log('  ledger          成本台账');
      console.log('  doctor          诊断');
      console.log('  engine/detect   引擎状态');
      break;
    }
  }
}

main().catch(e => console.error('错误:', e.message));
