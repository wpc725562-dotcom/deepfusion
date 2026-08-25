/**
 * test-acp.js — Reasonix ACP 实测：握手 → 会话 → prompt → 流式消息
 */
import { ReasonixAcpClient } from './engine/reasonix.js';

const API_KEY = process.env.A1233_API_KEY || process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  console.log('未找到 DeepSeek API key（需要 A1233_API_KEY 或 DEEPSEEK_API_KEY 环境变量）');
  process.exit(1);
}

// 自动检测 reasonix 完整路径（npm 全局 / PATH / Go bin）
import { detectReasonix } from './engine/manager.js';
const detected = detectReasonix();
const chosen = detected.find(d => /\\.cmd$/.test(d.bin)) || detected[0];
if (!chosen) { console.log('未检测到 reasonix，先执行: npm i -g reasonix'); process.exit(1); }
console.log('使用引擎: ' + chosen.bin + ' (' + chosen.source + ')');
const client = new ReasonixAcpClient({ bin: chosen.bin, cwd: process.cwd(), model: 'deepseek-chat' });
let sawMessage = false;
let sawStatus = false;

client.on('message/partial', (p) => {
  sawMessage = true;
  const t = p?.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
  process.stdout.write(t);
});
client.on('session/status', (p) => {
  sawStatus = true;
  console.log('\n[session/status] ' + JSON.stringify(p));
});
client.on('error', (e) => console.log('\n[error] ' + e.message));

console.log('1) 启动 reasonix acp…');
client.start();
await new Promise(r => setTimeout(r, 800));

console.log('2) initialize 握手…');
const init = await client.initialize();
console.log('   协议版本: ' + init.protocolVersion);
console.log('   agent: ' + JSON.stringify(init.agentInfo || {}).slice(0, 150));
console.log('   能力: ' + JSON.stringify(Object.keys(init.agentCapabilities || {})).slice(0, 200));

console.log('3) 创建会话…');
const sess = await client.createSession({ cwd: process.cwd() });
console.log('   sessionId: ' + sess.sessionId);

console.log('4) 发送 prompt（等流式回复，最长 90s）…');
await client.prompt({ sessionId: sess.sessionId, text: '你好，用一句话说明你是谁。' });
console.log('');

// 等待会话结束或超时
await new Promise((res) => {
  const timer = setTimeout(() => { console.log('\n[超时] 等待 90s 未收到 stopped'); res(); }, 90000);
  const h = (p) => {
    const st = p?.status;
    if (st === 'stopped' || st === 'completed' || st === 'failed' || st === 'error') {
      clearTimeout(timer);
      client.removeListener('session/status', h);
      res();
    }
  };
  client.on('session/status', h);
});

console.log('5) 会话状态查询…');
try {
  const st = await client.getSessionStatus(sess.sessionId);
  console.log('   ' + JSON.stringify(st).slice(0, 200));
} catch (e) { console.log('   (查询失败: ' + e.message + ')'); }

console.log('6) 清理…');
try { await client.closeSession(sess.sessionId); } catch {}
client.close();
console.log('\n=== 测试结论 ===');
console.log('收到流式消息: ' + (sawMessage ? '✅' : '❌'));
console.log('收到会话状态: ' + (sawStatus ? '✅' : '❌'));
console.log('stderr 摘要: ' + client.stderrBuf.slice(-300).replace(/\n/g, ' | '));