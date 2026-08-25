/**
 * skills.js — Skill 自动注入
 * 对话/任务时按关键词匹配 ~/.deepfusion/skills/<name>/SKILL.md 并注入 prompt
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const DEFAULT_SKILL_DIR = path.join(CONFIG_DIR, 'skills');

/** 列出技能 */
export function listSkills(skillDir = DEFAULT_SKILL_DIR) {
  if (!existsSync(skillDir)) return [];
  return readdirSync(skillDir)
    .filter(d => existsSync(path.join(skillDir, d, 'SKILL.md')))
    .map(name => {
      const md = readFileSync(path.join(skillDir, name, 'SKILL.md'), 'utf8');
      const titleLine = md.split('\n').find(l => l.startsWith('# ')) || '';
      const descLine = md.split('\n').find(l => l.startsWith('> ')) || '';
      return { name, title: titleLine.replace(/^#\s*/, '').trim(), desc: descLine.replace(/^>\s*/, '').trim(), md };
    });
}

/** 关键词匹配：技能名 + 标题 + 描述包含关键词 */
export function matchSkills(prompt, skills) {
  if (!prompt || !skills.length) return [];
  const words = prompt.toLowerCase();
  return skills.filter(s => {
    const hay = (s.name + ' ' + s.title + ' ' + s.desc).toLowerCase();
    // 技能名/标题中的词命中
    return s.name.toLowerCase().split(/[-_\s]/).some(w => w.length > 2 && words.includes(w))
      || s.title.toLowerCase().split(/[\s\u4e00-\u9fa5]/).some(w => w.length > 1 && words.includes(w));
  });
}

/** 构建注入后的 prompt：命中技能 → 把 SKILL.md 作为指令前缀 */
export function buildPromptWithSkills(prompt, skillDir = DEFAULT_SKILL_DIR, enabled = true) {
  if (!enabled) return prompt;
  const skills = listSkills(skillDir);
  const matched = matchSkills(prompt, skills);
  if (!matched.length) return prompt;
  const injected = matched.map(s => {
    return '【技能：' + s.name + '】\n' + s.md.slice(0, 4000);
  }).join('\n\n---\n\n');
  return injected + '\n\n【当前任务】\n' + prompt;
}
