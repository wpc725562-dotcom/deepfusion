/**
 * runner.js — Reasonix 执行引擎（run --events-jsonl 模式）
 *
 * 主执行器：直接调用 reasonix run 子命令
 *   reasonix run --events-jsonl --trajectory <tmp> [--model X] <任务文本>
 *
 * - stdout 输出脱敏 JSONL 事件（turn_started/turn_phase/stream_attempt/text/message/usage/run_done），
 *   逐行解析并回调 onEvent；usage/session_id/duration_ms/ok 从中提取。
 * - 脱敏事件不含正文，因此同时用 --trajectory 落盘完整事件流（含 text/message 正文），
 *   供最终文本提取（message 事件的 content / text 事件正文）。
 * - stderr 只收诊断，记录到 stderrBuf。
 * - Windows 下 .cmd/.bat 及 PATH 裸命令一律经 cmd.exe /c 包装（参考 reasonix.js start()）。
 */
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

/** 解析 usage（兼容原始键名 input_tokens/cache_miss_tokens/cache_read_input_tokens 与解析后键名），幂等 */
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
 * 用 reasonix run --events-jsonl 执行一个任务。
 * @param {object} opts
 * @param {string} opts.prompt       任务文本（位置参数传给 reasonix）
 * @param {string} [opts.cwd]        工作目录（默认 process.cwd()）
 * @param {string} [opts.model]      模型（deepseek-chat / deepseek-pro ...）
 * @param {string} [opts.bin]        reasonix 可执行文件，默认 'reasonix'
 * @param {number}  [opts.timeoutMs] 超时毫秒，默认 300000
 * @param {Function} [opts.onEvent]  每解析一个 stdout 事件回调 onEvent(event)
 * @returns {Promise<{ok, text, usage, sessionId, durationMs, events, error, stderr}>}
 */
export async function runReasonixTask({
  prompt,
  cwd,
  model,
  bin = 'reasonix',
  timeoutMs = 300000,
  onEvent = null
} = {}) {
  const events = [];
  const textParts = [];
  let usage = {};
  let sessionId = null;
  let durationMs = null;
  let runDoneOk = null;
  let stderrBuf = '';
  let error = null;
  const emptyUsage = () => parseUsage();

  if (!prompt) {
    return { ok: false, text: '', usage: emptyUsage(), sessionId: null, durationMs: null, events, error: 'prompt 不能为空', stderr: '' };
  }

  const trajFile = path.join(tmpdir(), 'reasonix-traj-' + process.pid + '-' + Date.now() + '.jsonl');
  const args = ['run', '--events-jsonl', '--trajectory', trajFile];
  if (model) args.push('--model', model);
  args.push(String(prompt));

  // Windows：.cmd/.bat 或裸命令（PATH 中的 reasonix/npx）用 cmd.exe /c 包装
  let launchBin, launchArgs;
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(bin)) {
    launchBin = 'cmd.exe';
    launchArgs = ['/c', bin, ...args];
  } else {
    launchBin = bin;
    launchArgs = args;
  }

  /** 从（完整/脱敏）事件对象里提取正文片段：优先 text 流式片段；message 事件仅在没有 text 片段时兜底 */
  let sawTextEvent = false;
  function collectText(ev) {
    const kind = ev?.kind || ev?.type || '';
    if (kind === 'text') {
      const t = ev?.text ?? ev?.delta ?? ev?.content;
      if (typeof t === 'string' && t) { textParts.push(t); sawTextEvent = true; }
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
      try { rmSync(trajFile, { force: true }); } catch {}
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

    // stdout = 脱敏 JSONL 事件流
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return; // 非 JSON 行忽略
      }
      events.push(ev);
      if (typeof onEvent === 'function') {
        try { onEvent(ev); } catch {}
      }
      const kind = ev?.kind || ev?.type || '';
      collectText(ev); // 万一脱敏事件带正文也收
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

    // stderr = 诊断
    proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    proc.on('error', (err) => {
      if (!settled) error = '启动 reasonix 失败: ' + (err.message || err);
    });

    proc.on('exit', (code) => {
      if (settled) return;
      if (timedOut) {
        finish({ ok: false, text: textParts.join(''), usage: parseUsage(usage), sessionId, durationMs, events, error: 'reasonix 执行超时（超过 ' + timeoutMs + 'ms），已强制终止', stderr: stderrBuf.slice(-2000) });
        return;
      }
      if (error) {
        finish({ ok: false, text: textParts.join(''), usage: parseUsage(usage), sessionId, durationMs, events, error, stderr: stderrBuf.slice(-2000) });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, text: textParts.join(''), usage: parseUsage(usage), sessionId, durationMs, events, error: 'reasonix 进程退出码非零: ' + code, stderr: stderrBuf.slice(-2000) });
        return;
      }
      // 完整事件流（trajectory）补正文：text 事件拼接 / message 事件 content
      try {
        for (const line of readFileSync(trajFile, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev?.event) collectText(ev.event);
          } catch {}
        }
      } catch {}
      // 从已收集的 events 数组取最后一条 usage/run_done（可能因事件循环时序未及时更新上方变量）
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
