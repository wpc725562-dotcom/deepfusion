/**
 * deepfusion session list/export — 会话管理
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const CONV_DIR = path.join(process.cwd(), 'data', 'conversations');

export async function sessionCmd(args) {
  const sub = args[0] || 'list';
  if (sub === 'list') {
    if (!existsSync(CONV_DIR)) { console.log('（无会话）'); return; }
    const files = readdirSync(CONV_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    if (!files.length) { console.log('（无会话）'); return; }
    for (const f of files) {
      try {
        const c = JSON.parse(readFileSync(path.join(CONV_DIR, f), 'utf8'));
        console.log((c.id || f.slice(0, 12)).slice(0, 18) + ' · ' + c.messages?.length + ' 条 · ' + (c.title || '').slice(0, 30));
      } catch {}
    }
    return;
  }
  if (sub === 'export') {
    const id = args[1];
    if (!id) { console.log('用法: deepfusion session export <conversationId>'); return; }
    const p = path.join(CONV_DIR, id.endsWith('.json') ? id : id + '.json');
    if (!existsSync(p)) { console.log('会话不存在: ' + id); return; }
    const c = JSON.parse(readFileSync(p, 'utf8'));
    process.stdout.write(JSON.stringify(c, null, 2));
    return;
  }
  console.log('子命令: list / export <id>');
}
