/**
 * DeepFusion 深融 — 四栏融合工作台前端
 * 依赖：原生 DOM API + fetch + ReadableStream
 */
const API = '';
let currentConvId = null;
let chatBusy = false;
let currentMode = 'normal';
let stopController = null;   // AbortController for SSE

function $(id) { return document.getElementById(id); }

/* ========== 工具函数 ========== */

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  return r.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatTime(d) { return (d || '').slice(5, 16).replace('T', ' '); }

/* ========== 多代理执行（总指挥 → 子代理池） ========== */

$('btn-goal')?.addEventListener('click', startMultiAgent);

async function startMultiAgent() {
  const input = $('chat-input');
  const objective = input.value.trim();
  if (!objective || chatBusy) return;
  const w = $('chat-window');
  const empty = w.querySelector('.chat-empty');
  if (empty) empty.remove();
  // 用户消息
  w.insertAdjacentHTML('beforeend', '<div class="msg user"><div class="msg-bubble">🧩 多代理执行：' + esc(objective) + '</div></div>');
  // 目标卡片
  const card = document.createElement('div');
  card.className = 'msg assistant';
  card.innerHTML = '<div class="msg-bubble"><div class="goal-card" id="goal-card"><div class="goal-head">🧩 多代理编排中…</div><div class="goal-progress">总指挥正在拆解目标…</div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div></div></div>';
  w.appendChild(card);
  w.scrollTop = w.scrollHeight;
  input.value = '';
  updateTokenEst(0);

  try {
    const j = await api('/api/goals', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective, deep: false, concurrency: 2 })
    });
    if (!j.ok) throw new Error(j.error || '创建失败');
    pollGoal(j.goal.id, card, objective);
  } catch (e) {
    card.querySelector('.goal-head').textContent = '❌ 编排失败: ' + e.message;
  }
}

const goalPollers = new Map();
function pollGoal(goalId, card, objective) {
  if (goalPollers.has(goalId)) return;
  goalPollers.set(goalId, true);
  const update = async () => {
    try {
      const j = await api('/api/goals/' + goalId);
      if (!j.ok) return;
      const g = j.goal;
      const head = card.querySelector('.goal-head');
      const prog = card.querySelector('.goal-progress');
      const fill = card.querySelector('.progress-fill');
      if (head) {
        if (g.status === 'done') head.textContent = '✅ 目标完成 · ' + (g.summary || (g.doneCount + '/' + g.totalCount));
        else if (g.status === 'failed') head.textContent = '❌ 目标失败: ' + (g.error || '');
        else if (g.phase === 'decomposing') head.textContent = '🧩 总指挥正在拆解目标…';
        else head.textContent = '🧩 执行中 · 子代理 ' + g.doneCount + '/' + g.totalCount;
      }
      if (prog) {
        const detail = (g.steps || []).map(s => (s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'failed' ? '❌' : '⬜') + ' ' + esc(s.title)).join('　');
        prog.textContent = detail || '总指挥正在拆解目标…';
      }
      if (fill) {
        const pct = g.totalCount ? Math.round(g.doneCount / g.totalCount * 100) : 0;
        fill.style.width = pct + '%';
      }
      // 完成则停止轮询 + 追加汇总
      if (g.status === 'done' || g.status === 'failed') {
        goalPollers.delete(goalId);
        const done = (g.steps || []).filter(s => s.status === 'done');
        if (done.length) {
          const summary = done.map(s => '【' + s.title + '】\n' + (s.result || '')).join('\n\n');
          card.querySelector('.msg-bubble').insertAdjacentHTML('beforeend', '<div class="text-part" style="margin-top:8px;border-top:1px dashed var(--border-soft);padding-top:8px">' + esc(summary).slice(0, 3000) + '</div>');
        }
        loadSubagents();
        refreshRightPanel();
        return;
      }
      loadSubagents();
      setTimeout(update, 2500);
    } catch { setTimeout(update, 3000); }
  };
  update();
}

/* ========== 子代理面板实时同步 ========== */

async function loadSubagents() {
  const el = $('subagents');
  const badge = $('agents-badge');
  if (!el) return;
  try {
    const j = await api('/api/goals');
    const active = (j.goals || []).filter(g => g.status === 'running');
    const total = active.reduce((n, g) => n + (g.doneCount || 0), 0);
    if (badge) {
      badge.classList.toggle('hidden', !active.length);
      badge.textContent = '⚙ ' + (active.length ? active.length + ' 目标 · ' + total + ' 子代理' : '0 激活');
    }
    if (!active.length) {
      el.innerHTML = '<div class="empty">0 个激活</div>';
      return;
    }
    el.innerHTML = active.map(g => {
      const running = (g.steps || []).filter(s => s.status === 'running').length;
      const label = g.phase === 'decomposing' ? '拆解中' : running + ' 运行 · ' + g.doneCount + '/' + g.totalCount;
      return '<div class="subagent-item"><span class="sa-dot"></span><span class="sa-name">' + esc(g.objective).slice(0, 16) + '</span><span class="sa-status">' + label + '</span></div>';
    }).join('');
  } catch {}
}

/* ========== Tab 切换 ========== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    $('panel-' + btn.dataset.tab).classList.add('active');
    // 进入对应标签页时刷新内容
    if (btn.dataset.tab === 'trace') renderTracePanel();
    if (btn.dataset.tab === 'context') renderContextPanel();
  });
});

/* ========== 左侧会话管理 ========== */

async function loadConversations() {
  const el = $('conv-groups');
  if (!el) return;
  try {
    const j = await api('/api/conversations');
    const convs = j.conversations || [];
    if (!convs.length) {
      el.innerHTML = '<div class="group"><div class="group-head" style="cursor:default">global <span class="g-count">0</span></div><div style="padding:6px;color:var(--dim)">暂无对话</div></div>';
      return;
    }
    const search = ($('conv-search')?.value || '').toLowerCase();
    const filtered = search ? convs.filter(c => (c.title || '').toLowerCase().includes(search)) : convs;
    el.innerHTML = filtered.map(c => `
      <button class="conv-item ${c.id === currentConvId ? 'active' : ''}" data-cid="${c.id}">
        <span class="conv-title">${esc(c.title)}</span>
        <span class="conv-meta">${c.messageCount} 条 · ${formatTime(c.updatedAt)}</span>
      </button>`).join('');
    el.querySelectorAll('.conv-item').forEach(b => b.addEventListener('click', () => openConversation(b.dataset.cid)));
    // 更新账户
    loadAccount();
  } catch {}
}

$('conv-search')?.addEventListener('input', () => loadConversations());
$('btn-new-conv')?.addEventListener('click', () => {
  currentConvId = null;
  $('chat-window').innerHTML = '<div class="chat-empty"><div class="ce-big">💬</div>开始新对话</div>';
  $('chat-cost').textContent = '';
  loadConversations();
});

async function openConversation(cid) {
  currentConvId = cid;
  try {
    const j = await api('/api/conversations/' + cid);
    renderMessages(j.conversation?.messages || []);
    loadConversations();
  } catch (e) { updateChatCost('打开对话失败: ' + e.message); }
}

/* ========== 消息渲染 ========== */

function renderMessages(messages) {
  const w = $('chat-window');
  if (!w) return;
  if (!messages || !messages.length) {
    w.innerHTML = '<div class="chat-empty"><div class="ce-big">💬</div>开始新对话。输入消息并发送。</div>';
    return;
  }
  w.innerHTML = messages.map(m => {
    const cls = m.role === 'user' ? 'user' : (m.content && m.content.includes('调用失败') ? 'assistant error' : 'assistant');
    const body = m.role === 'user' ? m.content : renderAssistantBody(m.content);
    let meta = '';
    if (m.usage) {
      const u = m.usage;
      meta = '<span class="msg-meta usage">💰 in=' + (u.inputTokens||0) + ' out=' + (u.outputTokens||0) + ' cache=' + (u.cacheHitTokens||0) + '</span>';
    } else if (m.at) {
      meta = '<span class="msg-meta">' + formatTime(m.at) + '</span>';
    }
    return '<div class="msg ' + cls + '"><div class="msg-bubble">' + body + (meta ? ' ' + meta : '') + '</div></div>';
  }).join('');
  w.scrollTop = w.scrollHeight;
}

function renderAssistantBody(text) {
  if (!text) return '';
  const out = [];
  let remaining = text;
  while (remaining.length) {
    // 代码块
    const codeMatch = remaining.match(/^```(\w*)\n?([\s\S]*?)\n?```/);
    if (codeMatch) {
      out.push('<div class="code-block"><div class="code-head"><span class="code-lang">' + esc(codeMatch[1] || 'text') + '</span><button onclick="copyCode(this)">📋</button></div><div class="code-body"><pre>' + esc(codeMatch[2]) + '</pre></div></div>');
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    // 思考块（ think 标签）
    const thinkMatch = remaining.match(/^<think>([\s\S]*?)<\/think>\n?/);
    if (thinkMatch) {
      out.push('<details class="think-block"><summary>🧠 思考过程</summary><div class="think-content">' + esc(thinkMatch[1]) + '</div></details>');
      remaining = remaining.slice(thinkMatch[0].length);
      continue;
    }
    // 普通文本：取到下一个特殊标记或结束
    const nextSpecial = remaining.search(/<\/think>|```/);
    const seg = nextSpecial > 0 ? remaining.slice(0, nextSpecial) : remaining;
    out.push('<span class="text-part">' + esc(seg) + '</span>');
    remaining = remaining.slice(seg.length);
  }
  return out.join('');
}

function copyCode(btn) {
  const pre = btn.closest('.code-block')?.querySelector('pre');
  if (pre) { navigator.clipboard.writeText(pre.textContent); btn.textContent = '✅'; setTimeout(() => btn.textContent = '📋', 1500); }
}

/* ========== SSE 流式对话 ========== */

async function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  _lastChatText = text;
  _lastChatModel = $('chat-model')?.value;
  _lastChatMode = currentMode;
  $('btn-chat-send').disabled = true;
  $('btn-chat-send').textContent = '发送中';
  $('btn-chat-stop').classList.remove('hidden');
  const model = $('chat-model')?.value || 'tokenrhythm/deepseek-v4-flash';

  const w = $('chat-window');
  const empty = w.querySelector('.chat-empty');
  if (empty) empty.remove();
  // 用户消息
  w.insertAdjacentHTML('beforeend', '<div class="msg user"><div class="msg-bubble">' + esc(text) + '</div></div>');
  // 助理消息容器（流式追加）
  const msgDiv = document.createElement('div');
  msgDiv.className = 'msg assistant';
  msgDiv.innerHTML = '<div class="msg-bubble"><span class="stream-body"></span><span class="stream-cursor"></span></div>';
  w.appendChild(msgDiv);
  w.scrollTop = w.scrollHeight;
  const bodyEl = msgDiv.querySelector('.stream-body');
  input.value = '';
  updateTokenEst(text.length);

  stopController = new AbortController();
  try {
    const r = await fetch(API + '/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: stopController.signal,
      body: JSON.stringify({ message: text, model, mode: currentMode, conversationId: currentConvId })
    });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finalText = '';
    let finalUsage = null;
    let finalDuration = null;
    let finalOk = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSSE(raw);
        if (!ev) continue;
        handleSSEEvent(ev, msgDiv, bodyEl, (v) => { finalText = v; }, (v) => { finalUsage = v; }, (v) => { finalDuration = v; }, (v) => { finalOk = v; });
      }
    }
    // buf 剩余
    if (buf.trim()) {
      const ev = parseSSE(buf.trim());
      if (ev) handleSSEEvent(ev, msgDiv, bodyEl, (v) => { finalText = v; }, (v) => { finalUsage = v; }, (v) => { finalDuration = v; }, (v) => { finalOk = v; });
    }

    // 移除光标
    const cursor = msgDiv.querySelector('.stream-cursor');
    if (cursor) cursor.remove();

    // 最终重新渲染为完整格式（代码块高亮、思考块折叠）
    if (finalText) {
      bodyEl.innerHTML = renderAssistantBody(finalText);
    }

    // 更新 usage / cost
    if (finalUsage) {
      msgDiv.insertAdjacentHTML('beforeend', '<span class="msg-meta usage">💰 in=' + (finalUsage.inputTokens||0) + ' out=' + (finalUsage.outputTokens||0) + ' cache=' + (finalUsage.cacheHitTokens||0) + '</span>');
      $('chat-cost').innerHTML = '💰 in=' + (finalUsage.inputTokens||0) + ' out=' + (finalUsage.outputTokens||0) + ' cache=' + (finalUsage.cacheHitTokens||0) + ' · ' + Math.round((finalDuration||0)/1000) + 's';
    }

    if (finalOk) {
      currentConvId = msgDiv.dataset.cid || currentConvId;
      loadConversations();
    }
    // 刷新右侧面板
    refreshRightPanel();
  } catch (e) {
    if (e.name === 'AbortError') {
      bodyEl.innerHTML = '（已停止）';
    } else {
      bodyEl.innerHTML = '（请求失败: ' + esc(e.message) + '）<button class="btn-retry" onclick="window.retryLastChat()">🔄 重试</button>';
      msgDiv.classList.add('error');
    }
    msgDiv.querySelector('.stream-cursor')?.remove();
  }
  chatBusy = false;
  $('btn-chat-send').disabled = false;
  $('btn-chat-send').textContent = '发送 ↑';
  $('btn-chat-stop').classList.add('hidden');
  stopController = null;
  w.scrollTop = w.scrollHeight;
}

function parseSSE(raw) {
  const lines = raw.split('\n');
  let event = 'message';
  let dataStr = '';
  for (const l of lines) {
    if (l.startsWith('event: ')) event = l.slice(7).trim();
    else if (l.startsWith('data: ')) dataStr += l.slice(6);
  }
  if (!dataStr) return null;
  try { return { event, data: JSON.parse(dataStr) }; }
  catch { return null; }
}

function handleSSEEvent(ev, msgDiv, bodyEl, setFinalText, setFinalUsage, setFinalDuration, setFinalOk) {
  const d = ev.data;
  switch (ev.event) {
    case 'turn_started':
      if (d.conversationId) { currentConvId = d.conversationId; msgDiv.dataset.cid = d.conversationId; }
      break;
    case 'text':
      if (d.text) bodyEl.innerHTML += esc(d.text);
      break;
    case 'phase':
      // 可选：显示阶段指示
      break;
    case 'usage':
      if (d.usage) setFinalUsage(d.usage);
      break;
    case 'context':
      // 更新右侧上下文环形
      updateContextRing(d);
      break;
    case 'run_done':
      setFinalText(d.text || '');
      setFinalDuration(d.durationMs);
      setFinalOk(d.ok);
      if (d.error) bodyEl.innerHTML += '\n[错误: ' + esc(d.error) + ']';
      break;
  }
}

/* ========== 停止流式 ========== */

$('btn-chat-stop')?.addEventListener('click', () => {
  if (stopController) { stopController.abort(); stopController = null; }
});

/* ========== 底部控制栏交互 ========== */

// 运行模式切换
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
  });
});

// 模型选择持久化
$('chat-model')?.addEventListener('change', (e) => {
  localStorage.setItem('df-model', e.target.value);
});
const savedModel = localStorage.getItem('df-model');
if (savedModel) $('chat-model').value = savedModel;

// 发送按钮
$('btn-chat-send')?.addEventListener('click', sendChat);
$('chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
// token 预估
$('chat-input')?.addEventListener('input', (e) => {
  updateTokenEst(e.target.value.length);
});

function updateTokenEst(len) {
  const el = $('token-est');
  if (el) el.textContent = Math.round(len * 1.3) + ' tok';
}

function updateChatCost(msg) {
  const el = $('chat-cost');
  if (el) el.textContent = msg;
}

/* ========== 右侧面板 ========== */

async function refreshRightPanel() {
  try {
    const [ctx, metrics, breakdown] = await Promise.all([
      api('/api/usage/context'),
      api('/api/session/metrics'),
      api('/api/usage/breakdown')
    ]);
    if (ctx.ok) updateContextRing(ctx);
    if (metrics.ok) updateMetrics(metrics);
    if (breakdown.ok) updateBreakdown(breakdown);
  } catch {}
}

function updateContextRing(d) {
  const pct = d.pct || 0;
  const num = $('ctx-num');
  if (num) num.textContent = pct + '%';
  const fg = $('ring-fg');
  if (fg) {
    const circ = 2 * Math.PI * 42;
    const offset = circ * (1 - Math.min(100, pct) / 100);
    fg.style.strokeDashoffset = offset;
    fg.className = 'ring-fg' + (pct > 80 ? ' danger' : pct > 60 ? ' warn' : '');
  }
  const detail = $('ctx-detail');
  if (detail) detail.textContent = '原始 ' + (d.rawTokens || 0) + ' · 压缩 ' + (d.compressedTokens || 0) + ' · 压缩率 ' + (d.ratio || 0);
}

function updateMetrics(d) {
  setText('m-hit', formatMs(d.avgHitMs));
  setText('m-cost', '¥' + ((d.totalCost || 0)).toFixed(4));
  setText('m-run', formatDuration(d.runSeconds));
  setText('m-req', d.requests || 0);
  setText('m-cache', (d.cacheHitRate || 0) + '%');
}
function setText(id, v) { const el = $(id); if (el) el.textContent = v; }
function formatMs(ms) { return ms ? (ms >= 1000 ? (ms/1000).toFixed(1) + 's' : ms + 'ms') : '--'; }
function formatDuration(s) {
  if (!s) return '--';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

function updateBreakdown(d) {
  const el = $('breakdown');
  if (!el) return;
  const total = (d.prompt || 0) + (d.completion || 0) + (d.reasoning || 0) + (d.other || 0) || 1;
  const bars = [
    { label: '提示词', val: d.prompt || 0, cls: 'prompt', pct: (d.prompt||0)/total*100 },
    { label: '回复', val: d.completion || 0, cls: 'completion', pct: (d.completion||0)/total*100 },
    { label: '推理', val: d.reasoning || 0, cls: 'reasoning', pct: (d.reasoning||0)/total*100 },
    { label: '其他', val: d.other || 0, cls: 'other', pct: (d.other||0)/total*100 }
  ];
  let html = bars.map(b => `
    <div class="bd-row">
      <div class="bd-label"><span>${b.label}</span><span>${b.val.toLocaleString()} (${b.pct.toFixed(1)}%)</span></div>
      <div class="bd-track"><div class="bd-fill ${b.cls}" style="width:${b.pct}%"></div></div>
    </div>`).join('');
  if (d.detail && d.detail.length) {
    html += '<div class="bd-detail">' + d.detail.slice(0, 6).map(i => '<div>' + formatTime(i.at) + ' ' + esc(i.title) + ' ¥' + (i.cost||0).toFixed(4) + '</div>').join('') + '</div>';
  }
  el.innerHTML = html;
}

/* ========== 账户信息 ========== */

async function loadAccount() {
  try {
    const j = await api('/api/account');
    const el = $('account-mini');
    if (el) el.textContent = '今日消耗 ¥' + ((j.todayCost || 0)).toFixed(4) + ' · ' + (j.requests || 0) + ' 请求';
  } catch {}
}

/* ========== 设置弹窗 ========== */

$('btn-settings')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-mask';
  overlay.innerHTML = `
    <div class="modal">
      <h2>⚙ 设置</h2>
      <div class="row"><label>默认模型</label><select id="dlg-model">
        <option value="deepseek-chat">tokenrhythm/deepseek-v4-flash</option>
        <option value="deepseek-pro">tokenrhythm/deepseek-v4-pro</option>
        <option value="deepseek-reasoner">tokenrhythm/qwen3.7-max</option>
      </select></div>
      <div class="row"><label>默认模式</label><select id="dlg-mode">
        <option value="normal">常规</option>
        <option value="ask">询问</option>
        <option value="auto">自动</option>
        <option value="yolo">Yolo</option>
        <option value="standard">标准</option>
        <option value="deliver">交付</option>
      </select></div>
      <div class="modal-actions">
        <button class="btn-ghost" id="dlg-close">关闭</button>
        <button class="btn-primary" id="dlg-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#dlg-close').onclick = () => overlay.remove();
  overlay.querySelector('#dlg-save').onclick = () => {
    const m = overlay.querySelector('#dlg-model').value;
    const md = overlay.querySelector('#dlg-mode').value;
    localStorage.setItem('df-model', m);
    localStorage.setItem('df-mode', md);
    $('chat-model').value = m;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === md));
    currentMode = md;
    overlay.remove();
  };
  overlay.querySelector('#dlg-model').value = $('chat-model')?.value || 'tokenrhythm/deepseek-v4-flash';
  overlay.querySelector('#dlg-mode').value = currentMode;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
});

/* ========== 初始化 ========== */

async function refresh() {
  if (chatBusy) return;
  try {
    loadConversations();
    refreshRightPanel();
  } catch {}
}

// 初始化模型/模式
const savedMode = localStorage.getItem('df-mode');
if (savedMode) {
  currentMode = savedMode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === savedMode));
}

// 对话默认页面
$('chat-window').innerHTML = '<div class="chat-empty"><div class="ce-big">💬</div>开始新对话。输入消息并发送。</div>';

refresh();
setInterval(refresh, 15000);

// 重试上一次发送的对话
let _lastChatText = null;
let _lastChatModel = null;
let _lastChatMode = null;
window.retryLastChat = function() {
  if (_lastChatText) {
    const input = $('chat-input');
    if (input) input.value = _lastChatText;
    sendChat();
  }
};

/* ========== 思考轨迹页渲染 ========== */

async function renderTracePanel() {
  const el = $('trace-window');
  if (!el) return;
  try {
    const j = await api('/api/goals');
    const goals = j.goals || [];
    if (!goals.length) {
      el.innerHTML = '<div class="panel-empty">暂无任务执行记录。使用多代理功能后，任务拆解与子代理全链路将在此展示。</div>';
      return;
    }
    // 取最新 5 个目标
    const recent = goals.slice(0, 5);
    el.innerHTML = recent.map(g => {
      const steps = (g.steps || []).filter(s => s.title);
      const stepHtml = steps.length
        ? steps.map(s => {
            const icon = s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'failed' ? '❌' : '⬜';
            const result = s.result ? '<div class="trace-result">' + esc(s.result).slice(0, 200) + '</div>' : '';
            return '<div class="trace-node ' + (s.status||'') + '"><div class="tn-head">' + icon + ' ' + esc(s.title) + '</div><div class="tn-meta">' + (s.status||'pending') + (s.durationMs ? ' · ' + (s.durationMs/1000).toFixed(1) + 's' : '') + '</div>' + result + '</div>';
          }).join('')
        : '<div class="trace-node"><div class="tn-head">⏳ 拆解中…</div><div class="tn-meta">总指挥正在拆解目标</div></div>';
      return '<div class="trace-group"><div class="trace-group-head">🎯 ' + esc(g.objective).slice(0, 40) + (g.objective.length > 40 ? '…' : '') + ' <span class="trace-status">' + (g.status === 'done' ? '✅ 完成' : g.status === 'failed' ? '❌ 失败' : '⏳ 进行中') + '</span></div>' + stepHtml + '</div>';
    }).join('');
  } catch {}
}

/* ========== 上下文页渲染 ========== */

async function renderContextPanel() {
  const el = $('context-window');
  if (!el) return;
  if (!currentConvId) {
    el.innerHTML = '<div class="panel-empty">未选择对话。选择对话后，系统提示词、历史消息、上下文信息将在此展示。</div>';
    return;
  }
  try {
    const j = await api('/api/conversations/' + currentConvId);
    const c = j.conversation;
    if (!c) {
      el.innerHTML = '<div class="panel-empty">对话不存在或已删除</div>';
      return;
    }
    const msgs = c.messages || [];
    const ctx = await api('/api/usage/context');
    let html = '';

    // 会话信息
    html += '<div class="ctx-section"><h3>📋 会话信息</h3><div class="ctx-info">';
    html += '<div class="ctx-row"><span>ID</span><code>' + esc(c.id) + '</code></div>';
    html += '<div class="ctx-row"><span>标题</span><b>' + esc(c.title) + '</b></div>';
    html += '<div class="ctx-row"><span>消息数</span><b>' + msgs.length + '</b></div>';
    if (ctx.ok) html += '<div class="ctx-row"><span>上下文</span><b>' + (ctx.pct || 0) + '%</b> <span class="dim">(' + (ctx.rawTokens||0) + ' tok)</span></div>';
    html += '</div></div>';

    // 系统提示词（如果有）
    const sysMsg = msgs.filter(m => m.role === 'system');
    if (sysMsg.length) {
      html += '<div class="ctx-section"><h3>⚙ 系统提示词</h3>';
      html += sysMsg.map(m => '<div class="ctx-msg system">' + esc(m.content).slice(0, 500) + '</div>').join('');
      html += '</div>';
    }

    // 最近消息（最多 6 条）
    const recent = msgs.slice(-6);
    if (recent.length) {
      html += '<div class="ctx-section"><h3>💬 最近消息</h3>';
      html += recent.map(m => {
        const roleLabel = m.role === 'user' ? '👤 用户' : '🤖 助手';
        const body = esc(m.content || '').slice(0, 300);
        return '<div class="ctx-msg ' + (m.role||'') + '"><div class="ctx-msg-head">' + roleLabel + ' <span class="dim">' + formatTime(m.at) + '</span></div><div class="ctx-msg-body">' + body + '</div></div>';
      }).join('');
      html += '</div>';
    }

    el.innerHTML = html;
  } catch {
    el.innerHTML = '<div class="panel-empty">加载上下文失败</div>';
  }
}

// 在打开对话时也刷新 context 面板
const _origOpenConv = openConversation;
openConversation = async function(cid) {
  await _origOpenConv(cid);
  renderContextPanel();
};