// DeepFusion 工作台前端
const API = '';
let currentConvId = null;
let chatBusy = false;

function $(id) { return document.getElementById(id); }

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  return r.json();
}

function showError(msg) {
  const b = $('error-banner');
  if (msg) { b.textContent = msg; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Tab 切换 ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'chat') loadConversations();
    if (btn.dataset.tab === 'settings') loadEngineInfo();
  });
});

// ── 引擎状态 ──
function renderEngine(engine) {
  const el = $('engine-info');
  if (!el) return;
  const st = engine.status || {};
  const dot = $('engine-dot');
  const pill = $('engine-text');
  if (st.selected) {
    dot.className = 'dot ok';
    pill.textContent = st.selected.source + ' · ' + (st.selected.version || '');
    el.innerHTML = `✅ <b>reasonix 引擎可用</b>
      <br>来源：<code>${esc(st.selected.source)}</code> 二进制：<code>${esc(st.selected.bin)}</code>
      <br>版本：<code>${esc(st.selected.version)}</code> 默认模型：<code>${esc(engine.model || 'deepseek-pro')}</code>`;
  } else {
    dot.className = 'dot bad';
    pill.textContent = '引擎不可用';
    el.innerHTML = `⚠️ <b>reasonix 引擎不可用</b><br>${esc(st.hint || '请先安装 reasonix')}`;
  }
}

function loadEngineInfo() {
  api('/api/engine').then(renderEngine).catch(() => {});
}

// ── 任务统计 ──
function renderStats(stats) {
  const el = $('stats');
  if (!el) return;
  el.innerHTML = `
    <div class="stat total"><b>${stats.total}</b><span>总数</span></div>
    <div class="stat pending"><b>${stats.pending}</b><span>待领</span></div>
    <div class="stat assigned"><b>${stats.assigned}</b><span>进行中</span></div>
    <div class="stat done"><b>${stats.done}</b><span>完成</span></div>
    <div class="stat stalled"><b>${stats.stalled}</b><span>停滞</span></div>`;
}

// ── 任务列表 ──
function renderTasks(tasks) {
  const el = $('task-list');
  if (!el) return;
  if (!tasks.length) { el.innerHTML = '<div class="task-meta">暂无任务。</div>'; return; }
  el.innerHTML = tasks.map(t => {
    const badge = t.stalled && t.status === 'assigned' ? 'stalled' : t.status;
    return `<div class="task">
      <div class="task-head">
        <span class="task-title">${esc(t.id)} · ${esc(t.title)}</span>
        <span class="badge ${badge}">${badge === 'stalled' ? '停滞' : esc(t.status)}</span>
      </div>
      <div class="task-meta">owner: ${esc(t.owner || '—')} · updated: ${esc((t.updatedAt||'').slice(0,19).replace('T',' '))}</div>
      ${t.verify ? '<div class="task-verify">🎯 验收: ' + esc(t.verify) + '</div>' : ''}
      ${t.costUsage ? '<div class="task-verify usage">💰 in=' + esc(t.costUsage.inputTokens) + ' out=' + esc(t.costUsage.outputTokens) + ' cache=' + esc(t.costUsage.cacheHitTokens) + '</div>' : ''}
      ${t.result ? '<div class="task-result">📦 ' + esc(t.result).slice(0,400) + '</div>' : ''}
    </div>`;
  }).join('');
}

// ── 成本台账 ──
async function loadLedger() {
  const el = $('ledger');
  if (!el) return;
  try {
    const j = await api('/api/ledger');
    const entries = j.entries || [];
    if (!entries.length) { el.innerHTML = '<div class="ledger-empty">暂无成本记录。派发任务后自动记录。</div>'; return; }
    el.innerHTML = entries.slice(0, 20).map(e => {
      const u = e.usage || {};
      const total = (u.inputTokens||0) + (u.cacheHitTokens||0) + (u.cacheMissTokens||0);
      const hitRate = total > 0 ? Math.round(((u.cacheHitTokens||0) / total) * 100) : 0;
      return `<div class="ledger-item">
        <span class="l-title">${esc(e.taskId || '')} · ${esc(e.title || '')}</span>
        <div class="l-meta">in=${u.inputTokens||0} out=${u.outputTokens||0} cache=${u.cacheHitTokens||0} <span class="hit">命中率 ${hitRate}%</span> · ${Math.round((e.durationMs||0)/1000)}s</div>
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = '<div class="ledger-empty">加载失败</div>'; }
}

// ── 对话 ──
async function loadConversations() {
  const el = $('conv-list');
  if (!el) return;
  try {
    const j = await api('/api/conversations');
    const convs = j.conversations || [];
    if (!convs.length) { el.innerHTML = '<div class="conv-item" style="cursor:default;color:var(--dim)">暂无对话</div>'; return; }
    el.innerHTML = convs.map(c => `
      <button class="conv-item ${c.id === currentConvId ? 'active' : ''}" data-cid="${c.id}">
        <span class="conv-title">${esc(c.title)}</span>
        <span class="conv-meta">${c.messageCount} 条 · ${esc((c.updatedAt||'').slice(5,16).replace('T',' '))}</span>
      </button>`).join('');
    el.querySelectorAll('.conv-item').forEach(b => b.addEventListener('click', () => openConversation(b.dataset.cid)));
  } catch (e) { el.innerHTML = '<div class="ledger-empty">加载失败</div>'; }
}

async function openConversation(cid) {
  currentConvId = cid;
  try {
    const j = await api('/api/conversations/' + cid);
    const c = j.conversation;
    renderMessages(c.messages);
    loadConversations();
  } catch (e) { showError('打开对话失败: ' + e.message); }
}

function renderMessages(messages) {
  const w = $('chat-window');
  if (!w) return;
  if (!messages || !messages.length) { w.innerHTML = '<div class="chat-empty">空对话，发条消息开始吧。</div>'; return; }
  w.innerHTML = messages.map(m => {
    const cls = m.role === 'user' ? 'msg user' : (m.content && m.content.includes('调用失败') ? 'msg assistant error' : 'msg assistant');
    let meta = '';
    if (m.usage) {
      const u = m.usage;
      meta = `<span class="msg-meta usage">💰 in=${u.inputTokens||0} out=${u.outputTokens||0} cache=${u.cacheHitTokens||0}</span>`;
    } else if (m.at) {
      meta = `<span class="msg-meta">${esc((m.at||'').slice(5,16).replace('T',' '))}</span>`;
    }
    return `<div class="${cls}">${esc(m.content)} ${meta}</div>`;
  }).join('');
  w.scrollTop = w.scrollHeight;
}

async function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  $('btn-chat-send').disabled = true;
  const model = $('chat-model').value;

  const w = $('chat-window');
  const empty = w.querySelector('.chat-empty');
  if (empty) empty.remove();
  w.insertAdjacentHTML('beforeend', '<div class="msg user">' + esc(text) + '</div>');
  w.insertAdjacentHTML('beforeend', '<div class="msg assistant">思考中…</div>');
  w.scrollTop = w.scrollHeight;
  input.value = '';

  try {
    const j = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentConvId, message: text, model })
    });
    const pending = w.querySelector('.msg.assistant:last-child');
    if (j.ok) {
      currentConvId = j.conversation.id;
      renderMessages(j.conversation.messages);
      const u = j.usage || {};
      $('chat-cost').innerHTML = `💰 本轮: in=${u.inputTokens||0} out=${u.outputTokens||0} cache=${u.cacheHitTokens||0} · ${Math.round((j.durationMs||0)/1000)}s`;
      loadConversations();
    } else {
      if (pending) pending.innerHTML = esc('（调用失败：' + (j.error || '未知') + '）') + '<span class="msg-meta">错误</span>';
      pending.className = 'msg assistant error';
    }
  } catch (e) {
    const pending = w.querySelector('.msg.assistant:last-child');
    if (pending) { pending.textContent = '（请求失败: ' + e.message + '）'; pending.className = 'msg assistant error'; }
  }
  chatBusy = false;
  $('btn-chat-send').disabled = false;
}

// ── 事件绑定 ──
$('dispatch-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = { title: $('task-title').value, context: $('task-context').value, verify: $('task-verify').value || null };
  try {
    await api('/api/tasks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    $('task-title').value = ''; $('task-context').value = ''; $('task-verify').value = '';
    refresh();
  } catch (e) { showError('创建失败: ' + e.message); }
});

$('btn-dispatch-all').addEventListener('click', async () => {
  if (!confirm('把队列中所有 pending 任务交给 reasonix 引擎执行？')) return;
  $('btn-dispatch-all').disabled = true;
  $('btn-dispatch-all').textContent = '执行中…';
  try {
    const r = await api('/api/dispatch', { method: 'POST' });
    const done = (r.results || []).filter(x => x.ok).length;
    alert('派发完成：成功 ' + done + ' 个，失败 ' + ((r.results||[]).length - done) + ' 个');
  } catch (e) { showError('派发失败: ' + e.message); }
  $('btn-dispatch-all').disabled = false;
  $('btn-dispatch-all').textContent = '⚡ 一键派发全部 pending';
  refresh();
});

$('btn-new-conv').addEventListener('click', () => {
  currentConvId = null;
  $('chat-window').innerHTML = '<div class="chat-empty">开始新对话。</div>';
  $('chat-cost').textContent = '';
  loadConversations();
});

$('btn-chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

// 设置：模型选择持久化
$('set-model').addEventListener('change', (e) => {
  localStorage.setItem('df-model', e.target.value);
  $('chat-model').value = e.target.value;
});
const savedModel = localStorage.getItem('df-model');
if (savedModel) { $('set-model').value = savedModel; $('chat-model').value = savedModel; }

// ── 刷新 ──
async function refresh() {
  try {
    const o = await api('/api/overview');
    renderEngine(o.engine);
    renderStats(o.stats);
    renderTasks(o.tasks);
    loadLedger();
    showError(null);
  } catch (e) { showError('加载失败: ' + e.message); }
}

refresh();
setInterval(refresh, 10000);
