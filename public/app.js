/* =========================================================
 * 凡人修仙传 · AI 说书人 — 前端逻辑
 * 职责：对话流、状态面板、打字动画、选项、存档（本地+导入导出）、道陨/转世
 * ========================================================= */
'use strict';

// ================= 工具 =================
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ================= 常量 =================
const SAVES_KEY = 'fanren.saves';
const MAX_KEEP_TURNS = 20; // 上下文只保留最近 20 轮，更早的浓缩进大事记

const INITIAL_STATE = () => ({
  realm: '凡人',
  lifespan: 100,
  spiritStones: 0,
  location: '七玄门',
  items: ['神秘小绿瓶'],
  milestone: 1, // 当前里程碑编号（见 /api/milestones）
});

// 里程碑总表（启动时拉取，用于面板与横幅展示）
let MILESTONES = [];
async function loadMilestones() {
  try {
    const resp = await fetch('/api/milestones');
    const data = await resp.json();
    if (resp.ok && data.ok !== false && Array.isArray(data.milestones)) {
      MILESTONES = data.milestones;
      renderStatePanel();
    }
  } catch (e) {
    console.warn('[里程碑加载失败]', e);
  }
}
function milestoneTitle(idx) {
  const m = MILESTONES[idx - 1];
  return m ? `${m.title}（${idx}/${MILESTONES.length}）` : null;
}

// ================= 存档（localStorage） =================
function loadSaves() {
  try {
    return JSON.parse(localStorage.getItem(SAVES_KEY)) || {};
  } catch {
    return {};
  }
}

function persistSaves(saves) {
  localStorage.setItem(SAVES_KEY, JSON.stringify(saves));
}

function saveCurrentSlot() {
  if (!game.slot) return;
  const saves = loadSaves();
  saves[game.slot] = {
    history: game.history,
    state: game.state,
    summary: game.summary,
    pastLife: game.pastLife,
    turnCount: game.turnCount,
    updatedAt: Date.now(),
  };
  persistSaves(saves);
  flashTip('已存档');
}

function readSlot(name) {
  const s = loadSaves()[name];
  if (!s) return null;
  return {
    history: s.history || [],
    state: Object.assign(INITIAL_STATE(), s.state || {}),
    summary: s.summary || '',
    pastLife: s.pastLife || null,
    turnCount: s.turnCount || 0,
  };
}

function deleteSlot(name) {
  const saves = loadSaves();
  delete saves[name];
  persistSaves(saves);
}

// ================= 游戏对象 =================
let game = {
  slot: null,
  history: [],
  state: INITIAL_STATE(),
  summary: '',
  pastLife: null,
  turnCount: 0,
  busy: false,
};

// 回复模式：detailed（默认）| brief（每轮可切换，粘性保持 + localStorage 持久化）
let replyMode = localStorage.getItem('fanren.replyMode') === 'brief' ? 'brief' : 'detailed';

function setReplyMode(mode) {
  replyMode = mode === 'brief' ? 'brief' : 'detailed';
  localStorage.setItem('fanren.replyMode', replyMode);
  el.modeBrief.classList.toggle('active', replyMode === 'brief');
  el.modeDetail.classList.toggle('active', replyMode === 'detailed');
}

// ================= DOM 引用 =================
const el = {
  slotName: $('slotName'),
  narrative: $('narrative'),
  options: $('options'),
  input: $('userInput'),
  btnSend: $('btnSend'),
  btnSave: $('btnSave'),
  btnLoad: $('btnLoad'),
  btnExport: $('btnExport'),
  btnImport: $('btnImport'),
  fileImport: $('fileImport'),
  btnKey: $('btnKey'),
  configModal: $('configModal'),
  cfgBaseUrl: $('cfgBaseUrl'),
  keyInput: $('keyInput'),
  cfgModel: $('cfgModel'),
  keyStatus: $('keyStatus'),
  btnKeySave: $('btnKeySave'),
  btnKeyClear: $('btnKeyClear'),
  btnKeyClose: $('btnKeyClose'),
  btnNew: $('btnNew'),
  loading: $('loading'),
  deathOverlay: $('deathOverlay'),
  deathReason: $('deathReason'),
  btnReincarnate: $('btnReincarnate'),
  btnNew2: $('btnNew2'),
  stRealm: $('st-realm'),
  stLifespan: $('st-lifespan'),
  stStones: $('st-stones'),
  stLocation: $('st-location'),
  stMilestone: $('st-milestone'),
  stItems: $('st-items'),
  stTip: $('st-tip'),
  slotModal: $('slotModal'),
  slotList: $('slotList'),
  btnModalClose: $('btnModalClose'),
  modeBrief: $('modeBrief'),
  modeDetail: $('modeDetail'),
};

// ================= 渲染 =================
function renderStatePanel() {
  const s = game.state;
  el.stRealm.textContent = s.realm || '—';
  el.stLifespan.textContent = s.lifespan != null ? `${s.lifespan} 岁` : '—';
  el.stStones.textContent = s.spiritStones != null ? `${s.spiritStones} 块` : '—';
  el.stLocation.textContent = s.location || '—';
  el.stMilestone.textContent = milestoneTitle(s.milestone) || (s.milestone ? `第 ${s.milestone} 章` : '—');
  el.stItems.innerHTML = '';
  (s.items || []).forEach((it) => {
    const li = document.createElement('li');
    li.textContent = it;
    el.stItems.appendChild(li);
  });
}

function scrollToBottom() {
  el.narrative.scrollTop = el.narrative.scrollHeight;
}

// 追加叙述块；返回 { div, paras }——paras 为段落文本列表，供打字机逐段揭示
// opts.instant = true 时直接写入完整文本（读档/导入重放用）
function appendTurnBlock(role, content, opts = {}) {
  const div = document.createElement('div');
  div.className = `turn turn-${role}`;
  const paras = [];

  if (role === 'assistant') {
    const label = document.createElement('span');
    label.className = 'turn-label label-assistant';
    label.textContent = '📖 说书人';
    div.appendChild(label);
    const chunks = String(content).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    chunks.forEach((pRaw) => {
      const p = document.createElement('p');
      if (/^「/.test(pRaw)) p.className = 'dialogue';
      else if (/^[（(*]/.test(pRaw)) p.className = 'thought';
      if (opts.instant) p.textContent = pRaw; // 非流式场景直接显示
      paras.push({ el: p, text: pRaw });
      div.appendChild(p);
    });
  } else if (role === 'user') {
    const label = document.createElement('span');
    label.className = 'turn-label label-user';
    label.textContent = '✦ 你';
    div.appendChild(label);
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = content;
    div.appendChild(text);
  } else {
    const p = document.createElement('p');
    p.textContent = content;
    div.appendChild(p);
  }

  el.narrative.appendChild(div);
  scrollToBottom();
  return { div, paras };
}

function appendSystem(msg) {
  appendTurnBlock('system', msg);
}

// 里程碑达成横幅
function appendMilestoneBanner(idx) {
  const m = MILESTONES[idx - 1];
  if (!m) return;
  const div = document.createElement('div');
  div.className = 'turn turn-milestone';
  div.textContent = `⚡ 里程碑达成 · 进入「${m.title}」(${m.vol})`;
  el.narrative.appendChild(div);
  scrollToBottom();
}

// 打字机式揭示：段落依次出现，当前段逐字打出，后续段落保持隐藏
// token 机制：新的一轮揭示开始后，旧揭示立即终止（打字途中点选项不会并发打架）
// speed <= 0 时直接完整显示（流式重建等场景）
let skipReveal = false;
let revealToken = 0;
async function revealBlock(paras, speed = 16) {
  const token = ++revealToken;
  skipReveal = false;
  for (const { el: p, text: final } of paras) {
    if (speed <= 0) { p.textContent = final; continue; }
    if (token !== revealToken || skipReveal) { p.textContent = final; continue; }
    p.textContent = '';
    for (let i = 0; i < final.length; i += 2) {
      if (token !== revealToken || skipReveal) { p.textContent = final; break; }
      p.textContent = final.slice(0, i + 2);
      scrollToBottom();
      await sleep(speed);
    }
    scrollToBottom();
  }
}

// 选项按钮（最多 3 个）
function renderOptions(options) {
  el.options.innerHTML = '';
  (options || []).slice(0, 3).forEach((o) => {
    const b = document.createElement('button');
    b.className = 'opt-btn';
    b.textContent = o;
    b.addEventListener('click', () => sendTurn(o));
    el.options.appendChild(b);
  });
}

function flashTip(msg) {
  el.stTip.textContent = msg;
  setTimeout(() => {
    if (el.stTip.textContent === msg) {
      el.stTip.textContent = game.state.alive === false ? '韩立已陨……' : '可自由输入行动，或点击上方选项';
    }
  }, 1800);
}

// ================= 状态合并（钳制） =================
function mergeState(diff) {
  if (!diff || typeof diff !== 'object') return;
  const s = game.state;
  if (typeof diff.realm === 'string' && diff.realm) s.realm = diff.realm;
  if (typeof diff.lifespan === 'number') s.lifespan = Math.max(0, Math.round(diff.lifespan));
  if (typeof diff.spiritStones === 'number') s.spiritStones = Math.max(0, Math.round(diff.spiritStones));
  if (typeof diff.location === 'string' && diff.location) s.location = diff.location;
  if (Array.isArray(diff.items)) s.items = diff.items;
  renderStatePanel();

  if (diff.dead) {
    s.alive = false;
    game.pastLife = diff.deathReason || '陨落于修行路上';
    showDeath(game.pastLife);
  }
}

function showDeath(reason) {
  el.deathReason.textContent = reason;
  el.deathOverlay.classList.remove('hidden');
  renderOptions([]);
  el.input.disabled = true;
  el.btnSend.disabled = true;
  el.stTip.textContent = '韩立已陨……';
}

// ================= 核心对话流 =================
async function sendTurn(userText, opts = {}) {
  if (game.busy || game.state.alive === false) return;
  game.busy = true;
  el.input.disabled = true;
  el.btnSend.disabled = true;
  renderOptions([]);

  if (!opts.quiet) appendTurnBlock('user', userText);
  game.history.push({ role: 'user', content: userText });
  game.turnCount++;

  // 历史压缩：超长时把最老的一批送去浓缩为大事记（异步，不阻塞）
  if (game.history.length > MAX_KEEP_TURNS * 2) {
    const keep = game.history.slice(-(MAX_KEEP_TURNS * 2));
    const dropped = game.history.slice(0, game.history.length - MAX_KEEP_TURNS * 2);
    game.history = keep;
    summarizeAsync(dropped);
  }

  el.stTip.textContent = replyMode === 'brief' ? '简略模式推演中……' : '详细模式推演中……';
  el.loading.classList.remove('hidden');
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: game.history,
          state: game.state,
          summary: game.summary,
          pastLife: game.pastLife,
          mode: replyMode,
        }),
      });
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('ndjson') || ct.includes('stream')) {
        await handleStreamResponse(resp); // 流式：文字实时浮现
      } else {
        // 兜底：非流式 JSON 响应
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.ok === false) throw new Error(data.error || `服务器错误（${resp.status}）`);
        applyAssistant(data);
      }
    } catch (err) {
      // 移除未得到回复的玩家回合，允许重试
      if (stream && stream.block) stream.block.remove();
      stream = null;
      game.history.pop();
      game.turnCount--;
      appendSystem(`⚠️ 传讯失败：${err.message}。请重试。`);
    } finally {
    game.busy = false;
    el.input.disabled = game.state.alive === false;
    el.btnSend.disabled = game.state.alive === false;
    el.loading.classList.add('hidden');
    if (game.state.alive !== false) {
      el.stTip.textContent = '可自由输入行动，或点击上方选项';
    }
    saveCurrentSlot(); // 自动存档（回合开始时也已存过，此为补充）
    el.input.focus();
  }
}

function applyAssistant(data) {
  const narrative = (data.narrative || '').trim() || '（说书人沉默了片刻……）';
  const { paras } = appendTurnBlock('assistant', narrative);

  // 历史中保留叙述与选项（省略【状态】行，状态已由面板单独跟踪）
  let msg = narrative;
  if (Array.isArray(data.options) && data.options.length) {
    msg += '\n【选项】\n' + data.options.map((o) => '- ' + o).join('\n');
  }
  game.history.push({ role: 'assistant', content: msg });

  renderOptions(data.options || []);
  mergeState(data.stateDiff || {});

  // 里程碑推进（后端已校验顺序）：更新面板 + 横幅
  if (typeof data.milestone === 'number' && data.milestone >= 1) {
    const prev = game.state.milestone || 1;
    game.state.milestone = data.milestone;
    if (data.milestoneAdvanced || data.milestone > prev) {
      appendMilestoneBanner(data.milestone);
    }
    renderStatePanel();
  }

  revealBlock(paras);
}

// 大事记压缩（异步）
async function summarizeAsync(droppedTurns) {
  try {
    const resp = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: game.summary, turns: droppedTurns }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok !== false && data.summary) {
      game.summary = data.summary;
      saveCurrentSlot();
    }
  } catch (e) {
    console.warn('[大事记压缩失败]', e);
  }
}

// ================= 新游戏 / 转世 =================
function startNewGame({ reincarnate = false } = {}) {
  const oldDeath = game.pastLife;
  const slot = game.slot || `韩立·${new Date().toISOString().slice(0, 10)}`;

  game = {
    slot,
    history: [],
    state: INITIAL_STATE(),
    summary: '',
    pastLife: reincarnate ? oldDeath : null,
    turnCount: 0,
    busy: false,
  };

  el.narrative.innerHTML = '';
  renderOptions([]);
  renderStatePanel();
  el.deathOverlay.classList.add('hidden');
  el.input.disabled = false;
  el.btnSend.disabled = false;
  el.slotName.textContent = slot;
  saveCurrentSlot();

  if (reincarnate) {
    appendSystem('✨ 轮回已启，前尘如烟……');
  } else {
    appendSystem('📜 故事开始。韩立，凡人一个，却已握住了自己的命运。');
  }
  sendTurn('故事开始。', { quiet: true });
}

// ================= 存档 / 读档 / 导入导出 =================
function doSave() {
  const defaultName = game.slot || `韩立·${new Date().toISOString().slice(0, 10)}`;
  const name = window.prompt('存档名称：', defaultName);
  if (!name) return;
  game.slot = name.trim();
  el.slotName.textContent = game.slot;
  saveCurrentSlot();
}

function showSlotModal() {
  const saves = loadSaves();
  const names = Object.keys(saves).sort((a, b) => (saves[b].updatedAt || 0) - (saves[a].updatedAt || 0));
  el.slotList.innerHTML = '';

  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'slot-empty';
    empty.textContent = '暂无存档。点「存档」保存当前进度。';
    el.slotList.appendChild(empty);
  }

  names.forEach((name) => {
    const s = saves[name];
    const item = document.createElement('div');
    item.className = 'slot-item';

    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${s.state?.realm || '?'} · ${fmtTime(s.updatedAt || 0)} · 第 ${s.turnCount || 0} 回合`;
    info.appendChild(nm);
    info.appendChild(meta);

    const loadBtn = document.createElement('button');
    loadBtn.className = 'load-btn';
    loadBtn.textContent = '读取';
    loadBtn.addEventListener('click', () => {
      loadSlotInto(name);
      el.slotModal.classList.add('hidden');
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => {
      if (window.confirm(`删除存档「${name}」？此操作不可恢复。`)) {
        deleteSlot(name);
        if (game.slot === name) game.slot = null;
        showSlotModal(); // 刷新列表
      }
    });

    item.appendChild(info);
    item.appendChild(loadBtn);
    item.appendChild(delBtn);
    el.slotList.appendChild(item);
  });

  el.slotModal.classList.remove('hidden');
}

// 读档恢复：完整回放全部对话
function loadSlotInto(name) {
  const g = readSlot(name);
  if (!g) return;
  game = Object.assign({}, game, g, { busy: false });
  el.slotName.textContent = name;
  el.deathOverlay.classList.add('hidden');
  el.input.disabled = false;
  el.btnSend.disabled = false;
  renderFull();
}

// 根据 history 重放渲染（读档/导入后调用）
function renderFull() {
  el.narrative.innerHTML = '';
  game.history.forEach((t) => {
    if (t.role === 'assistant') {
      appendTurnBlock('assistant', String(t.content).split('\n【选项】')[0], { instant: true });
    } else if (t.role === 'user') {
      appendTurnBlock('user', t.content);
    }
  });
  renderStatePanel();
  renderOptions([]);
  scrollToBottom();
  el.stTip.textContent = game.state.alive === false ? '韩立已陨……' : '已读取存档，继续修行';
}

function exportSave() {
  const data = {
    version: 1,
    slot: game.slot || '未命名',
    history: game.history,
    state: game.state,
    summary: game.summary,
    pastLife: game.pastLife,
    turnCount: game.turnCount,
    exportedAt: Date.now(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `凡人修仙传-${(game.slot || '存档').replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importSave(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.history)) throw new Error('不是有效的存档文件');
      let name = String(data.slot || '导入存档');
      const saves = loadSaves();
      if (saves[name]) {
        const renamed = window.prompt(`存档「${name}」已存在，请输入新名称：`, `${name}-导入`);
        if (!renamed) return;
        name = renamed.trim();
      }
      game = {
        slot: name,
        history: data.history,
        state: Object.assign(INITIAL_STATE(), data.state || {}),
        summary: data.summary || '',
        pastLife: data.pastLife || null,
        turnCount: data.turnCount || 0,
        busy: false,
      };
      el.slotName.textContent = name;
      el.deathOverlay.classList.add('hidden');
      el.input.disabled = false;
      el.btnSend.disabled = false;
      renderFull();
      saveCurrentSlot();
    } catch (e) {
      window.alert('导入失败：' + e.message);
    }
  };
  reader.readAsText(file);
}

// ================= API 供应商配置 =================
let keyConfigured = null;
let cfgInfo = { baseUrl: '', model: '' };

async function checkKeyStatus() {
  try {
    const resp = await fetch('/api/config/status');
    const data = await resp.json();
    keyConfigured = !!(resp.ok && data.configured);
    cfgInfo = { baseUrl: data.baseUrl || '', model: data.model || '' };
    renderKeyStatus();
    if (!keyConfigured) {
      appendSystem('⚠️ 尚未配置 API 密钥：点击右上角「API密钥」按钮，填入 API Key 后即可开始修行。');
    }
  } catch (e) {
    keyConfigured = false;
    renderKeyStatus();
  }
}

function renderKeyStatus() {
  if (keyConfigured === true) {
    el.keyStatus.textContent = `✅ 已配置 · ${cfgInfo.model || ''} @ ${cfgInfo.baseUrl || ''}`;
    el.keyStatus.className = 'key-status ok';
  } else if (keyConfigured === false) {
    el.keyStatus.textContent = '⚠️ 未配置';
    el.keyStatus.className = 'key-status';
  } else {
    el.keyStatus.textContent = '';
    el.keyStatus.className = 'key-status';
  }
}

async function saveConfig() {
  const baseUrl = el.cfgBaseUrl.value.trim();
  const apiKey = el.keyInput.value.trim();
  const model = el.cfgModel.value.trim();
  if (!apiKey) {
    el.keyStatus.textContent = '请先输入密钥';
    el.keyStatus.className = 'key-status';
    return;
  }
  el.keyStatus.textContent = '验证中……';
  el.keyStatus.className = 'key-status';
  el.btnKeySave.disabled = true;
  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, model }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok !== false) {
      keyConfigured = true;
      cfgInfo = { baseUrl: data.baseUrl, model: data.model };
      renderKeyStatus();
      setTimeout(() => el.configModal.classList.add('hidden'), 1500);
    } else {
      el.keyStatus.textContent = '❌ ' + (data.error || `保存失败（${resp.status}）`);
      el.keyStatus.className = 'key-status';
    }
  } catch (e) {
    el.keyStatus.textContent = '❌ ' + e.message;
    el.keyStatus.className = 'key-status';
  } finally {
    el.btnKeySave.disabled = false;
  }
}

async function clearConfig() {
  if (!window.confirm('清除已保存的 API 配置？')) return;
  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok !== false) {
      keyConfigured = false;
      cfgInfo = { baseUrl: '', model: '' };
      renderKeyStatus();
      el.keyStatus.textContent = '已清除';
      el.keyStatus.className = 'key-status';
    } else {
      el.keyStatus.textContent = '❌ ' + (data.error || '清除失败');
      el.keyStatus.className = 'key-status';
    }
  } catch (e) {
    el.keyStatus.textContent = '❌ ' + e.message;
    el.keyStatus.className = 'key-status';
  }
}

// ================= 流式回复处理 =================
// 后端以 NDJSON 逐行推送：{type:'text',delta} → {type:'parsing'} → {type:'done',...} / {type:'error'}
let stream = null;

async function handleStreamResponse(resp) {
  stream = { block: null, pending: '', raw: '', shownLen: 0, firstText: false };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let doneMsg = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'text') onStreamText(msg.delta || '');
        else if (msg.type === 'parsing') el.stTip.textContent = '正在整理状态与选项……';
        else if (msg.type === 'done') doneMsg = msg;
        else if (msg.type === 'error') throw new Error(msg.error || '服务器错误');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!doneMsg) throw new Error('流式响应中断');
  applyStreamDone(doneMsg);
}

// 流式增量：只显示【选项】/【状态】标记之前的叙述部分
function onStreamText(delta) {
  if (!stream.firstText) {
    stream.firstText = true;
    el.loading.classList.add('hidden');
    el.stTip.textContent = replyMode === 'brief' ? '说书人正在书写（简略）……' : '说书人正在书写（详细）……';
  }
  stream.raw += delta;
  const iOpt = stream.raw.indexOf('【选项】');
  const iSt = stream.raw.indexOf('【状态】');
  const cut = Math.min(iOpt < 0 ? Infinity : iOpt, iSt < 0 ? Infinity : iSt);
  const display = stream.raw.slice(0, cut);
  const newPart = display.slice(stream.shownLen);
  stream.shownLen = display.length;
  if (newPart) appendStreamedText(newPart);
}

// 流式文字按空行分段，逐段落渲染（实时浮现）
function appendStreamedText(text) {
  if (!stream.block) {
    stream.block = document.createElement('div');
    stream.block.className = 'turn turn-assistant';
    const label = document.createElement('span');
    label.className = 'turn-label label-assistant';
    label.textContent = '📖 说书人';
    stream.block.appendChild(label);
    el.narrative.appendChild(stream.block);
  }
  stream.pending += text;
  const parts = stream.pending.split(/\n\s*\n/);
  stream.pending = parts.pop(); // 最后一段可能不完整，留待下一块
  for (const part of parts) {
    const t = part.trim();
    if (t) addStreamPara(t);
  }
  scrollToBottom();
}

function addStreamPara(t) {
  const p = document.createElement('p');
  if (/^「/.test(t)) p.className = 'dialogue';
  else if (/^[（(*]/.test(t)) p.className = 'thought';
  p.textContent = t;
  stream.block.appendChild(p);
}

// 流结束：冲刷残余段落、解析选项/状态/里程碑、重建校验
function applyStreamDone(msg) {
  const tail = (stream.pending || '').trim();
  if (tail) addStreamPara(tail);

  const narrative = (msg.narrative || '').trim() || '（说书人沉默了片刻……）';
  const parasText = stream.block
    ? Array.from(stream.block.querySelectorAll('p'))
        .map((p) => p.textContent)
        .join('\n\n')
        .trim()
    : '';
  const normalized = narrative
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  // 极端情况（如流式渲染与解析结果不一致）：以解析结果重建
  if (parasText !== normalized) {
    if (stream.block) stream.block.remove();
    const { paras } = appendTurnBlock('assistant', narrative);
    revealBlock(paras, 0);
  }

  let histMsg = narrative;
  if (Array.isArray(msg.options) && msg.options.length) {
    histMsg += '\n【选项】\n' + msg.options.map((o) => '- ' + o).join('\n');
  }
  game.history.push({ role: 'assistant', content: histMsg });

  renderOptions(msg.options || []);
  mergeState(msg.stateDiff || {});

  // 里程碑推进（后端已校验顺序）：更新面板 + 横幅
  if (typeof msg.milestone === 'number' && msg.milestone >= 1) {
    const prev = game.state.milestone || 1;
    game.state.milestone = msg.milestone;
    if (msg.milestoneAdvanced || msg.milestone > prev) {
      appendMilestoneBanner(msg.milestone);
    }
    renderStatePanel();
  }
  stream = null;
}

// ================= 初始化 =================
function bindEvents() {
  el.btnSend.addEventListener('click', () => {
    const text = el.input.value.trim();
    if (text) {
      el.input.value = '';
      sendTurn(text);
    }
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = el.input.value.trim();
      if (text) {
        el.input.value = '';
        sendTurn(text);
      }
    }
  });
  // 点击正文跳过打字动画
  el.narrative.addEventListener('click', () => { skipReveal = true; });

  el.btnSave.addEventListener('click', doSave);
  el.btnLoad.addEventListener('click', showSlotModal);
  el.btnModalClose.addEventListener('click', () => el.slotModal.classList.add('hidden'));
  el.btnExport.addEventListener('click', exportSave);
  el.btnImport.addEventListener('click', () => el.fileImport.click());
  el.fileImport.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importSave(f);
    e.target.value = '';
  });
  el.btnNew.addEventListener('click', () => {
    if (window.confirm('开启一段新的修行？当前进度已自动存档，可从「读档」找回。')) {
      startNewGame();
    }
  });
  el.btnReincarnate.addEventListener('click', () => startNewGame({ reincarnate: true }));
  el.btnNew2.addEventListener('click', () => {
    if (window.confirm('重开新档？将失去这一世的一切（包括记忆）。')) {
      startNewGame();
    }
  });

  // 回复模式切换（简略/详细）
  el.modeBrief.addEventListener('click', () => setReplyMode('brief'));
  el.modeDetail.addEventListener('click', () => setReplyMode('detailed'));

  // 密钥配置
  el.btnKey.addEventListener('click', () => {
    el.cfgBaseUrl.value = cfgInfo.baseUrl || 'https://api.deepseek.com';
    el.cfgModel.value = cfgInfo.model || 'deepseek-v4-flash';
    el.keyInput.value = '';
    renderKeyStatus();
    el.configModal.classList.remove('hidden');
    el.keyInput.focus();
  });
  el.btnKeySave.addEventListener('click', saveConfig);
  el.btnKeyClear.addEventListener('click', clearConfig);
  el.btnKeyClose.addEventListener('click', () => el.configModal.classList.add('hidden'));
  el.keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveConfig();
  });
}

function init() {
  bindEvents();
  setReplyMode(replyMode); // 恢复持久化的回复模式
  renderStatePanel();
  loadMilestones();
  checkKeyStatus();

  const saves = loadSaves();
  const names = Object.keys(saves);
  if (names.length) {
    appendSystem('📜 检测到已有存档。点右上角「读档」继续之前的修行，或点「新游戏」另开新局。');
  } else {
    appendSystem('⭐ 欢迎来到《凡人修仙传·人界篇》。点击「新游戏」，韩立的命运将由你执笔。');
  }
  el.slotName.textContent = game.slot || '未开局';
}

init();
