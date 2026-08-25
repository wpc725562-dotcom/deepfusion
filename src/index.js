#!/usr/bin/env node
/**
 * index.js — DeepFusion CLI 入口
 *   deepfusion web           启动 Web 工作台
 *   deepfusion engine        查看引擎状态
 *   deepfusion task add ...  添加任务
 *   deepfusion dispatch      派发全部 pending 给 reasonix（默认并发 2）
 *   deepfusion run <taskId>  派发单个任务
 *   deepfusion ledger        查看成本台账（data/ledger.json）
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { engineStatus, detectReasonix, loadConfig, saveConfig } from './engine/manager.js';
import { createTask, listTasks, applyAction, getTask } from './core/queue.js';
import { dispatchToReasonix, dispatchAllPending } from './core/orchestrator.js';

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'web': {
      await import('./server.js');
      break;
    }
    case 'engine': {
      const st = engineStatus();
      console.log('=== Reasonix 引擎状态 ===');
      if (!st.detected.length) {
        console.log('未检测到引擎。安装: npm i -g reasonix && reasonix setup');
      } else {
        for (const d of st.detected) console.log('  [' + d.source + '] ' + d.bin + ' → ' + d.version);
        console.log('可用: ' + (st.usable ? '是' : '否'));
      }
      break;
    }
    case 'task': {
      const sub = args[0];
      if (sub === 'add') {
        const t = createTask({ title: args[1] || '未命名', context: args.slice(2).join(' ') });
        console.log('已创建: ' + t.id + ' [' + t.status + '] ' + t.title);
      } else if (sub === 'list') {
        for (const t of listTasks()) {
          console.log(t.id + ' [' + t.status + '] ' + (t.stalled ? '⚠停滞 ' : '') + t.title + ' owner=' + (t.owner || '-'));
        }
      } else {
        console.log('用法: deepfusion task add <标题> [上下文...] | list');
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
    case 'detect': {
      console.log(JSON.stringify(detectReasonix(), null, 2));
      break;
    }
    case 'ledger': {
      const ledgerFile = path.join(process.cwd(), 'data', 'ledger.json');
      if (!existsSync(ledgerFile)) {
        console.log('台账不存在: ' + ledgerFile);
        console.log('提示：还没有产生执行记录。先派发任务（deepfusion run/dispatch），成功后会写入台账。');
        break;
      }
      let entries = [];
      try {
        entries = JSON.parse(readFileSync(ledgerFile, 'utf8'));
        if (!Array.isArray(entries)) entries = [];
      } catch (e) {
        console.error('台账解析失败: ' + ledgerFile + ' — ' + String(e.message || e));
        break;
      }
      console.log('=== DeepFusion 成本台账 === (' + ledgerFile + ')');
      if (!entries.length) {
        console.log('（空）暂无派发记录');
        break;
      }
      console.log('共 ' + entries.length + ' 条记录');
      for (const e of entries) {
        const u = e.usage || {};
        const hit = (u.cacheHitTokens || 0) + (u.cacheMissTokens || 0);
        const hitRate = hit > 0 ? Math.round((u.cacheHitTokens / hit) * 10000) / 100 + '%' : '-';
        console.log(
          (e.at || '').slice(0, 19) + '  ' + (e.taskId || '-') +
          '  in=' + (u.inputTokens ?? 0) + ' out=' + (u.outputTokens ?? 0) +
          ' cache=' + hitRate + ' dur=' + (e.durationMs ?? '-') + 'ms' +
          '  ' + (e.title || '').slice(0, 40)
        );
      }
      break;
    }
    default:
      console.log('DeepFusion · 深融 — DSH × Reasonix 融合 Agent 引擎');
      console.log('');
      console.log('用法:');
      console.log('  deepfusion web              启动 Web 工作台 (http://127.0.0.1:43210)');
      console.log('  deepfusion engine           查看 reasonix 引擎状态');
      console.log('  deepfusion task add <标题>  添加任务');
      console.log('  deepfusion task list        列出任务');
      console.log('  deepfusion run <taskId>     派发单个任务给 reasonix');
      console.log('  deepfusion dispatch         派发全部 pending 任务（--concurrency 参数可调并发，默认 2）');
      console.log('  deepfusion ledger           查看成本台账 data/ledger.json');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
