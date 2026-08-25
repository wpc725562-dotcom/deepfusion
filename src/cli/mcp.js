/**
 * deepfusion mcp add/list/remove — MCP 服务器管理（client 侧）
 */
import { loadConfig, saveGlobalConfig } from '../core/config.js';

export async function mcpCmd(args) {
  const sub = args[0] || 'list';
  const cfg = loadConfig();
  const servers = cfg.mcp?.servers || [];

  if (sub === 'list' || !sub) {
    if (!servers.length) { console.log('（无 MCP 服务器）deepfusion mcp add <name> <command>'); return; }
    console.log('🔌 MCP 服务器 (' + servers.length + '):');
    for (const s of servers) console.log('  ' + (s.enabled === false ? '⏸' : '✅') + ' ' + s.name + ' — ' + (s.command || '') + (s.args?.length ? ' ' + s.args.join(' ') : ''));
    if (cfg.mcp?.expose) console.log('📡 作为 MCP Server 暴露: 开启');
    return;
  }
  if (sub === 'add') {
    const name = args[1], command = args[2];
    if (!name || !command) { console.log('用法: deepfusion mcp add <name> <command> [args...]'); return; }
    const existing = servers.findIndex(s => s.name === name);
    const entry = { name, command, args: args.slice(3), enabled: true };
    if (existing >= 0) servers[existing] = entry; else servers.push(entry);
    cfg.mcp.servers = servers;
    saveGlobalConfig(cfg);
    console.log('✅ MCP 已添加: ' + name + ' → ' + command);
    return;
  }
  if (sub === 'remove') {
    const name = args[1];
    if (!name) { console.log('用法: deepfusion mcp remove <name>'); return; }
    cfg.mcp.servers = servers.filter(s => s.name !== name);
    saveGlobalConfig(cfg);
    console.log('已移除: ' + name);
    return;
  }
  console.log('子命令: list / add / remove');
}
