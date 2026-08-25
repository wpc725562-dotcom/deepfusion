/**
 * deepfusion plugin add/list/remove/doctor — 插件管理
 * 插件目录：~/.deepfusion/plugins/
 * 声明式插件：一个目录含 plugin.json（name/description/version/type）
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { CONFIG_DIR, ensureDirs, loadConfig, saveGlobalConfig } from '../core/config.js';

const PLUGIN_DIR = path.join(CONFIG_DIR, 'plugins');

export function pluginList() {
  ensureDirs();
  const list = [];
  for (const name of readdirSync(PLUGIN_DIR)) {
    const dir = path.join(PLUGIN_DIR, name);
    const pj = path.join(dir, 'plugin.json');
    if (!existsSync(pj)) continue;
    try {
      const meta = JSON.parse(readFileSync(pj, 'utf8'));
      list.push({ name, ...meta });
    } catch {}
  }
  return list;
}

export async function pluginCmd(args) {
  ensureDirs();
  const sub = args[0];
  const cfg = loadConfig();
  const enabled = cfg.plugins?.enabled || [];

  if (sub === 'list' || !sub) {
    const list = pluginList();
    if (!list.length) { console.log('（无插件）使用 deepfusion plugin add <git-url|path> 添加'); return; }
    for (const p of list) {
      const on = enabled.includes(p.name) ? '✅' : '⏸';
      console.log(on + ' ' + p.name + ' v' + (p.version || '0') + ' — ' + (p.description || ''));
    }
    return;
  }
  if (sub === 'add') {
    const src = args[1];
    if (!src) { console.log('用法: deepfusion plugin add <git-url|本地路径>'); return; }
    const name = args[2] || (src.endsWith('.git') ? src.split('/').pop().replace('.git','') : path.basename(src));
    try {
      const dest = path.join(PLUGIN_DIR, name);
      if (src.startsWith('http') || src.startsWith('git@')) {
        execSync('git clone --depth 1 ' + src + ' "' + dest + '"', { stdio: 'pipe' });
      } else {
        mkdirSync(dest, { recursive: true });
        execSync('cp -r "' + src + '"/* "' + dest + '/"', { shell: '/bin/bash' });
      }
      if (!enabled.includes(name)) { enabled.push(name); cfg.plugins.enabled = enabled; saveGlobalConfig(cfg); }
      console.log('✅ 插件已添加: ' + name);
    } catch (e) {
      console.log('❌ 添加失败: ' + String(e.message).slice(0, 200));
    }
    return;
  }
  if (sub === 'remove') {
    const name = args[1];
    if (!name) { console.log('用法: deepfusion plugin remove <name>'); return; }
    const idx = enabled.indexOf(name);
    if (idx >= 0) { enabled.splice(idx, 1); cfg.plugins.enabled = enabled; saveGlobalConfig(cfg); }
    console.log('已移除（配置）: ' + name + '（目录未删，可用 deepfusion plugin rm --dir 删除）');
    return;
  }
  if (sub === 'doctor') {
    const list = pluginList();
    console.log('插件健康检查: ' + list.length + ' 个插件');
    for (const p of list) {
      const on = enabled.includes(p.name);
      const hasSkills = existsSync(path.join(PLUGIN_DIR, p.name, 'skills'));
      const hasMCP = existsSync(path.join(PLUGIN_DIR, p.name, 'mcp.json'));
      console.log((on ? '✅' : '⏸') + ' ' + p.name + (on ? '' : ' (未启用)') + (hasSkills ? ' +skills' : '') + (hasMCP ? ' +mcp' : ''));
    }
    return;
  }
  console.log('子命令: list / add / remove / doctor');
}