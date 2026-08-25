/**
 * reasonix.js — Reasonix ACP v1 客户端（ACP 备用）
 * 注意：主执行路径已切换到 runner.js（reasonix run --events-jsonl），
 * 本文件仅作 ACP 备用保留，不参与默认调度。
 * 
 * Reasonix 以 ACP v1（NDJSON JSON-RPC 2.0 over stdio）暴露 agent 能力：
 *   reasonix acp [--model deepseek-pro]
 * stdout 只承载 ACP 消息，诊断信息走 stderr（不可合并两流）。
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export class ReasonixAcpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.bin  reasonix 可执行文件（默认 'reasonix'，走 PATH 或 npx）
   * @param {string} [opts.model]  启动模型（如 deepseek-pro）
   * @param {string} [opts.cwd]  工作目录
   * @param {boolean} [opts.useNpx] 通过 npx 启动（当 reasonix 未全局安装时）
   */
  constructor(opts = {}) {
    super();
    this.bin = opts.bin || 'reasonix';
    this.model = opts.model || null;
    this.cwd = opts.cwd || process.cwd();
    this.useNpx = opts.useNpx ?? false;
    this.proc = null;
    this.rl = null;
    this.pending = new Map();   // id -> {resolve, reject, method}
    this.nextId = 1;
    this.sessionId = null;
    this.capabilities = null;
    this.info = null;
    this.stderrBuf = '';
    this.ready = false;
  }

  get connected() { return !!this.proc && this.proc.exitCode === null; }

  /** 启动 reasonix acp 子进程并建立流式读取 */
  start() {
    const args = ['acp'];
    if (this.model) args.push('--model', this.model);

    let launchBin, launchArgs, useCmd;
    if (this.useNpx) {
      // 通过 npx 启动：npx(.cmd) reasonix acp
      launchBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      launchArgs = [this.bin, ...args];
      useCmd = process.platform === 'win32';
    } else if (/\.(cmd|bat)$/i.test(this.bin)) {
      // 显式 .cmd/.bat 路径（npm 全局安装）：cmd.exe /c <bin> acp
      launchBin = 'cmd.exe';
      launchArgs = ['/c', this.bin, ...args];
      useCmd = true;
    } else {
      // 直接二进制
      launchBin = this.bin;
      launchArgs = args;
      useCmd = false;
    }

    this.proc = spawn(launchBin, launchArgs, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });

    // stdout = ACP 消息（NDJSON 逐行）
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const msg = JSON.parse(t);
        this._handleMessage(msg);
      } catch (e) {
        this.emit('protocol-error', { raw: t.slice(0, 200), error: String(e) });
      }
    });

    // stderr = 诊断信息（不解析为 ACP）
    this.proc.stderr.on('data', (d) => {
      this.stderrBuf += d.toString();
      if (this.stderrBuf.length > 8000) this.stderrBuf = this.stderrBuf.slice(-8000);
      this.emit('stderr', d.toString());
    });

    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, signal) => {
      this.ready = false;
      this.emit('exit', { code, signal, stderr: this.stderrBuf.slice(-2000) });
      for (const { reject } of this.pending.values()) reject(new Error('reasonix acp 进程已退出'));
      this.pending.clear();
    });
    return this;
  }

  /** 内部消息分发 */
  _handleMessage(msg) {
    // 响应（有 id 且匹配 pending）
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`ACP 方法 ${p.method} 错误: ${JSON.stringify(msg.error).slice(0, 300)}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // 通知（无 id，有 method）
    if (msg.method) {
      this.emit('notification', msg);
      this.emit(msg.method, msg.params);
      return;
    }
    this.emit('unknown-message', msg);
  }

  /** 发送 JSON-RPC 请求，等待响应 */
  _request(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('reasonix acp 未运行'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      this.proc.stdin.write(line + '\n');
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP 方法 ${method} 超时 (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      // 把 timer 存起来以便清理
      const p = this.pending.get(id);
      if (p) p.timer = timer;
    });
  }

  /** 发送 JSON-RPC 通知（不等待响应） */
  _notify(method, params) {
    if (!this.connected) throw new Error('reasonix acp 未运行');
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }

  /** ACP initialize 握手 */
  async initialize() {
    const result = await this._request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        mcp: { http: true, sse: false }
      },
      clientInfo: { name: 'deepfusion', version: '0.1.0' }
    }, 30000);
    this.capabilities = result.agentCapabilities || null;
    this.info = result.agentInfo || null;
    this.ready = true;
    // 通知 agent 客户端已就绪（ACP 规范：initialize 后发 initialized 通知）
    this._notify('initialized', { protocolVersion: result.protocolVersion ?? 1 });
    return result;
  }

  /** 创建会话（ACP session/new） */
  async createSession({ cwd = this.cwd, workspaceId = null } = {}) {
    const params = { sessionParams: {} };
    if (workspaceId) params.sessionParams.workspaceId = workspaceId;
    else params.sessionParams.cwd = cwd;
    const result = await this._request('session/new', params, 30000);
    this.sessionId = result.sessionId;
    this.emit('session-created', { sessionId: this.sessionId });
    return result;
  }

  /** 发送提示词（ACP v1：prompt 为 ContentBlock[] 数组） */
  async prompt({ sessionId = this.sessionId, text, messages = null }) {
    if (!sessionId) throw new Error('未创建会话，先调用 createSession');
    // ACP v1 ContentBlock 数组：[{type:'text',text}, ...]
    const promptMsg = Array.isArray(messages) && messages.length
      ? messages
      : [{ type: 'text', text: String(text) }];
    const result = await this._request('session/prompt', {
      sessionId,
      prompt: promptMsg
    }, 120000); // 2 分钟上限（生产可配长超时）
    return result;
  }

  /** 获取会话状态（ACP session/status） */
  async getSessionStatus(sessionId = this.sessionId) {
    const result = await this._request('session/status', { sessionId }, 15000);
    return result;
  }

  /** 列出会话 */
  async listSessions() {
    const result = await this._request('session/list', {}, 15000);
    return result;
  }

  /** 恢复会话 */
  async resumeSession(sessionId) {
    const result = await this._request('session/resume', { sessionId }, 30000);
    this.sessionId = result.sessionId;
    return result;
  }

  /** 关闭会话 */
  async closeSession(sessionId = this.sessionId) {
    const result = await this._request('session/close', { sessionId }, 15000);
    this.sessionId = null;
    return result;
  }

  /** 终止进程 */
  close() {
    if (this.proc && this.connected) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill(); } catch {}
    }
  }
}

/** 便捷函数：一次性跑一个任务（起进程 → 握手 → 建会话 → prompt → 收集消息 → 退出） */
export async function runReasonixTask({
  prompt,
  cwd,
  model,
  bin = 'reasonix',
  useNpx = false,
  timeoutMs = 300000,
  onEvent = null
} = {}) {
  const client = new ReasonixAcpClient({ bin, model, cwd, useNpx });
  const messages = [];
  let sessionId = null;
  let status = 'running';
  let error = null;

  client.on('message/partial', (p) => {
    const t = p?.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
    if (t) messages.push({ type: 'partial', text: t });
    if (onEvent) onEvent({ type: 'message/partial', text: t });
  });
  client.on('message/complete', (p) => {
    const t = p?.message?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
    if (t) messages.push({ type: 'complete', text: t });
    if (onEvent) onEvent({ type: 'message/complete', text: t });
  });
  client.on('permission/request', (p) => {
    // 默认自动批准 Reasonix 的文件/命令权限（可配置收紧）
    if (onEvent) onEvent({ type: 'permission/request', detail: p });
    try { client._notify('permission/response', { requestId: p?.requestId, decision: { allow: true } }); } catch {}
  });
  client.on('session/status', (p) => {
    status = p?.status || status;
    if (onEvent) onEvent({ type: 'session/status', status });
  });

  try {
    client.start();
    await new Promise((res, rej) => {
      client.once('exit', (x) => x.code === null ? null : null); // 忽略正常退出
      // 等进程起来
      setTimeout(res, 500);
    });
    await client.initialize();
    const sess = await client.createSession({ cwd });
    sessionId = sess.sessionId;
    await client.prompt({ sessionId, text: prompt });
    // 等待会话结束（streaming 完成后 agent 会发 session/status stopped）
    await new Promise((res) => {
      const timer = setTimeout(() => { client.removeListener('session/status', h); res(); }, timeoutMs);
      const h = (p) => {
        const st = p?.status;
        if (st === 'stopped' || st === 'completed' || st === 'failed' || st === 'error') {
          status = st;
          clearTimeout(timer);
          client.removeListener('session/status', h);
          res();
        }
      };
      client.on('session/status', h);
    });
  } catch (e) {
    error = String(e.message || e);
  } finally {
    try { await client.closeSession(sessionId).catch(() => {}); } catch {}
    client.close();
  }

  return { sessionId, status, messages, error, stderr: client.stderrBuf.slice(-1500) };
}