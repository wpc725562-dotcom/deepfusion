/**
 * deepfusion skill list/load — 技能管理
 * ~/.deepfusion/skills/<name>/SKILL.md（DSH 兼容格式）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, ensureDirs } from '../core/config.js';

const SKILL_DIR = path.join(CONFIG_DIR, 'skills');

export async function skillCmd(args) {
  ensureDirs();
  const sub = args[0] || 'list';
  if (sub === 'list') {
    const names = readdirSync(SKILL_DIR).filter(d => existsSync(path.join(SKILL_DIR, d, 'SKILL.md')));
    if (!names.length) { console.log('（无技能）把 SKILL.md 放到 ~/.deepfusion/skills/<name>/SKILL.md'); return; }
    for (const n of names) {
      const md = readFileSync(path.join(SKILL_DIR, n, 'SKILL.md'), 'utf8');
      const first = md.split('\n').find(l => l.startsWith('#')) || n;
      console.log('🎯 ' + n + ' — ' + first.replace(/^#+\s*/, '').slice(0, 60));
    }
    return;
  }
  if (sub === 'load') {
    const name = args[1];
    const p = path.join(SKILL_DIR, name, 'SKILL.md');
    if (!name || !existsSync(p)) { console.log('未找到技能: ' + name); return; }
    process.stdout.write(readFileSync(p, 'utf8'));
    return;
  }
  if (sub === 'dir') {
    console.log(SKILL_DIR);
    return;
  }
  console.log('子命令: list / load <name> / dir');
}
