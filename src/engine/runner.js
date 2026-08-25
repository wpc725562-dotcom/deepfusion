/**
 * runner.js — Reasonix 执行引擎
 *
 * 两种运行模式：
 *   1) events-jsonl（默认）：reasonix run --events-jsonl --trajectory <tmp> <任务>
 *      - stdout 脱敏事件（不含正文），正文从 trajectory 落盘提取
 *   2) stream-json（SSE 流式）：reasonix run --output-format stream-json <任务>
 *      - stdout 带正文的流式 JSON（text 增量 / message / result / usage），
 *        适合前端实时打字机渲染
 *
 * usage 解析兼容原始键名（input_tokens/cache_read_input_tokens/...）与解析后键名。
 */
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';

/** 解析 usage（兼容原始键名与解析后键名），幂等 */
function parseUsage(u = {}) {
  return {
    inputTokens: Number(u.input_tokens ?? u.inputTokens) || 0,
    outputTokens: Number(u.output_tokens ?? u.outputTokens) || 0,
    cacheHitTokens: Number(u.cache_hit_tokens ?? u.cache_read_input_tokens ?? u.cacheHitTokens) || 0,
    cacheMissTokens: Number(u.cache_miss_tokens ?? u.cache_creation_input_tokens ?? u.cacheMissTokens) || 0
  };
}

/** 计算缓存命中率（缓存 token / 提示词 token，百分数） */
export function cacheHitRate(usage = {}) {
  const u = parseUsage(usage);
  const promptTokens = u.cacheHitTokens + u.cacheMissTokens;
  const total = promptTokens > 0 ? promptTokens : u.inputTokens;
  if (total <= 0) return 0;
  return Math.round((u.cacheHitTokens / total) * 10000) / 100;
}

/**
 * 用 reasonix 执行一个任务。
 * @param {object} opts
 * @param {string} opts.prompt       任务文本（位置参数传给 reasonix）
 * @param {string} [opts.cwd]        工作目录（默认 process.cwd()）
 * @param {string} [opts.model]      模型（deepseek-chat / deepseek-pro ...）
 * @param {string} [opts.bin]        reasonix 可执行文件，默认 'reasonix'
 * @param {number}  [opts.timeoutMs] 超时毫秒，默认 300000
 * @param {Function} [opts.onEvent]  每解析一个 stdout 事件回调 onEvent(event)
 * @param {boolean}  [opts.streamJson] true 用 --output-format stream-json（正文流式）
 * @returns {Promise<{ok, text, usage, sessionId, durationMs, events, error, stderr}>}
 */
export async function runReasonixTask({
  prompt,
  cwd,
  model,
  bin = 'reasonix',
  timeoutMs = 300000,
  onEvent = null,
  streamJson = false
} = {}) {
  const events = [];
  const textParts = [];
  let usage = {};
  let sessionId = null;
  let durationMs = null;
  let runDoneOk = null;
  let resultOk = null;   // stream-json 的 result 事件 is_error
  let resultText = null; // stream-json 的 result 事件 result
  let stderrBuf = '';
  let error = null;
  const emptyUsage = () => parseUsage();

/**
 * Windows：把 npm .cmd shim 解析为 node + 实际 js 入口，
 * 直接 spawn node.exe，绕过 cmd.exe /c 包装（后台进程不会管道阻塞）
 */
function resolveReasonixLaunch(bin) {
  if (process.platform !== 'win32') return { bin, args: [] };
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const find = (name) => {
    for (const d of dirs) {
      const p = path.join(d, name);
      if (existsSync(p)) return p;
    }
    return null;
  };
  const shim = find(bin + '.cmd') || find(bin) || null;
  if (!shim) return { bin, args: [] };
  if (/\\.exe$/i.test(shim)) return { bin: shim, args: [] };
  if (/\\.cmd$/i.test(shim)) {
    // npm shim 模式：<dp0>\node_modules\<pkg>\bin\<name>.js
    const m = /node_modules\\([^\\]+)\\bin\\([^\\]+)$/.exec(shim);
    if (m) {
      const js = path.join(path.dirname(shim), 'node_modules', m[1], 'bin', m[2].replace(/\.cmd$/i, '') + '.js');
      if (existsSync(js)) return { bin: 'node', args: [js] };
    }
    // npm 全局安装：<dp0>\node_modules\<binName>\bin\<binName>.js
    const binName = path.basename(shim).replace(/\.cmd$/i, '');
    const globalJs = path.join(path.dirname(shim), 'node_modules', binName, 'bin', binName + '.js');
    if (existsSync(globalJs)) return { bin: 'node', args: [globalJs] };
    // 通用 .cmd 解析：提取 js 入口（含 %dp0% 变量）
    try {
      const content = readFileSync(shim, 'utf8');
      // 匹配 %dp0%\node_modules\...js 模式
      const jm = content.match(/%dp0%\\([^\s&"]+\.js)/i);
      if (jm) {
        const js = path.join(path.dirname(shim), jm[1]);
        if (existsSync(js)) return { bin: 'node', args: [js] };
      }
      // 匹配字面路径模式
      const jm2 = content.match(/\s"([^"]*node_modules[^"]+\.js)"\s+/);
      if (jm2 && existsSync(jm2[1])) return { bin: 'node', args: [jm2[1]] };
    } catch {}
  }
  return { bin, args: [] };
}

/**
 * 在 Windows 上解析 reasonix 启动路径，直接 spawn node + js 入口，
 * 绕过 cmd.exe /c 包装 + npm .cmd shim 的 goto 技巧问题。
 */
function resolveWinLaunch(bin, args) {
  // 先尝试解析 npm .cmd shim → node + js 入口
  const resolved = resolveReasonixLaunch(bin);
  if (resolved.bin !== bin && resolved.bin === 'node' && resolved.args.length > 0) {
    return { bin: 'node', args: [...resolved.args, ...args] };
  }
  // 若直接是 .exe
  if (/\\.exe$/i.test(resolved.bin)) {
    return { bin: resolved.bin, args };
  }
  // 兜底：仍用 cmd /c 但走完整路径
  const fullPath = resolved.bin !== bin ? resolved.bin : bin;
  return { bin: 'cmd.exe', args: ['/c', fullPath, ...args] };
}

  if (!prompt) {
    return { ok: false, text: '', usage: emptyUsage(), sessionId: null, durationMs: null, events, error: 'prompt 不能为空', stderr: '' };
  }

  const trajFile = path.join(tmpdir(), 'reasonix-traj-' + process.pid + '-' + Date.now() + '.jsonl');
  const args = streamJson
    ? ['run', '--output-format', 'stream-json']
    : ['run', '--events-jsonl', '--trajectory', trajFile];
  if (model) args.push('--model', model);
  args.push('--permission-mode', 'auto');
  args.push('--effort', 'disabled');
  args.push(String(prompt));

  // Windows：优先解析 npm .cmd shim → node + js 入口，绕过 cmd.exe /c 包装
  let launchBin, launchArgs;
  if (process.platform === 'win32') {
    const win = resolveWinLaunch(bin, args);
    launchBin = win.bin;
    launchArgs = win.args;
  } else {
    launchBin = bin;
    launchArgs = args;
  }

  if (process.platform === 'win32') {
    console.log('[runner] 启动 reasonix: bin=' + launchBin + ' args=' + JSON.stringify(launchArgs));
  }

  let sawTextEvent = false;
  function collectText(ev) {
    const kind = ev?.kind || ev?.type || '';
    if (kind === 'text') {
      const t = ev?.text ?? ev?.delta ?? ev?.content;
      if (typeof t === 'string' && t) { textParts.push(t); sawTextEvent = true; }
    } else if (kind === 'result' || kind === 'reply') {
      const t = ev?.result ?? ev?.text ?? ev?.content;
      if (typeof t === 'string' && t) { resultText = t; textParts.push(t); sawTextEvent = true; }
      if (typeof ev?.is_error === 'boolean') resultOk = !ev.is_error;
      else if (typeof ev?.subtype === 'string') resultOk = ev.subtype !== 'error';
      if (ev?.session_id) sessionId = ev.session_id;
      if (typeof ev?.duration_ms === 'number') durationMs = ev.duration_ms;
      if (ev?.usage) usage = parseUsage(ev.usage);
    } else if (kind === 'message' && !sawTextEvent) {
      const t = ev?.content ?? ev?.text ?? ev?.message?.content;
      const s = typeof t === 'string' ? t : Array.isArray(t) ? t.map(b => b?.text || '').join('') : '';
      if (s) textParts.push(s);
    }
  }

  return await new Promise((resolve) => {
    let proc;
    let timedOut = false;
    let timer = null;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (!streamJson) rmSync(trajFile, { force: true }); } catch {}
      resolve(value);
    };

    try {
      proc = spawn(launchBin, launchArgs, {
        cwd: cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
    } catch (e) {
      finish({ ok: false, text: '', usage: emptyUsage(), sessionId: null, durationMs: null, events, error: '启动 reasonix 失败: ' + (e.message || e), stderr: stderrBuf });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (proc && proc.pid) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          }
          proc.kill();
        } catch {}
      }
    }, timeoutMs);

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return;
      }
      events.push(ev);
      if (typeof onEvent === 'function') {
        try { onEvent(ev); } catch {}
      }
      const kind = ev?.kind || ev?.type || '';
      collectText(ev);
      if (kind === 'usage') {
        usage = ev?.usage ? parseUsage(ev.usage) : parseUsage(ev);
      }
      if (kind === 'run_done') {
        if (typeof ev?.ok === 'boolean') runDoneOk = ev.ok;
        else if (ev?.status) runDoneOk = ev.status === 'done' || ev.status === 'completed';
        if (ev?.session_id) sessionId = ev.session_id;
        if (typeof ev?.duration_ms === 'number') durationMs = ev.duration_ms;
        if (ev?.usage) usage = parseUsage(ev.usage);
      }
      if (ev?.session_id && !sessionId) sessionId = ev.session_id;
      if (typeof ev?.duration_ms === 'number' && durationMs === null) durationMs = ev.duration_ms;
    });

    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    proc.on('error', (err) => {
      if (!settled) {
        error = '启动 reasonix 失败: ' + (err.message || err);
        console.error('[runner] 启动 reasonix 失败:', err.message || err, '| stderr:', stderrBuf.slice(-1000));
      }
    });

    proc.on('exit', (code) => {
      if (settled) return;
      if (timedOut) {
        console.error('[runner] reasonix 执行超时 (' + timeoutMs + 'ms) | stderr:', stderrBuf.slice(-1000));
        finish({ ok: false, text: textParts.join(''), usage: parseUsage(usage), sessionId, durationMs, events, error: 'reasonix 执行超时（超过 ' + timeoutMs + 'ms），已强制终止', stderr: stderrBuf.slice(-2000) });
        return;
      }
      if (error) {
        console.error('[runner] reasonix 错误:', error, '| stderr:', stderrBuf.slice(-1000));
        finish({ ok: false, text: textParts.join(''), usage: parseUsage(usage), sessionId, durationMs, events, error: error + ' | stderr: ' + stderrBuf.slice(-500).trim(), stderr: stderrBuf.slice(-2000) });
        return;
      }
      if (code !== 0) {
        const stderrDetail = stderrBuf.slice(-1000).trim();
        const errMsg = 'reasonix 进程退出码非零: ' + code + (stderrDetail ? ' | stderr: ' + stderrDetail : '');
        console.error('[runner] ' + errMsg);
        finish({ ok: false, text: textParts.join(''), usage: parseUsage(usage), sessionId, durationMs, events, error: errMsg, stderr: stderrBuf.slice(-2000) });
        return;
      }

      if (streamJson) {
        // 再扫一遍 events 补 usage/session/duration/result（时序兜底）
        for (const ev of events) collectText(ev);
        const ok = resultOk === null ? (resultText !== null || textParts.length > 0) : resultOk;
        finish({
          ok,
          text: resultText !== null ? resultText : textParts.join(''),
          usage: parseUsage(usage),
          sessionId, durationMs, events,
          error: ok ? null : 'reasonix 未报告成功完成',
          stderr: stderrBuf.slice(-2000)
        });
        return;
      }

      // events-jsonl：trajectory 补正文
      try {
        for (const line of readFileSync(trajFile, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev?.event) collectText(ev.event);
          } catch {}
        }
      } catch {}
      for (const ev of events) {
        const kind = ev?.kind || ev?.type || '';
        if (kind === 'usage') {
          usage = ev?.usage ? parseUsage(ev.usage) : parseUsage(ev);
        }
        if (kind === 'run_done') {
          if (typeof ev?.ok === 'boolean') runDoneOk = ev.ok;
          else if (ev?.status) runDoneOk = ev.status === 'done' || ev.status === 'completed';
          if (ev?.session_id) sessionId = ev.session_id;
          if (typeof ev?.duration_ms === 'number') durationMs = ev.duration_ms;
          if (ev?.usage) usage = parseUsage(ev.usage);
        }
        if (ev?.session_id) sessionId = ev.session_id;
        if (typeof ev?.duration_ms === 'number') durationMs = ev.duration_ms;
      }
      const ok = runDoneOk === null ? textParts.length > 0 : !!runDoneOk;
      finish({
        ok,
        text: textParts.join(''),
        usage: parseUsage(usage),
        sessionId,
        durationMs,
        events,
        error: ok ? null : 'reasonix 未报告成功完成（run_done.ok=false）',
        stderr: stderrBuf.slice(-2000)
      });
    });
  });
}