/**
 * 凡人修仙传 · AI 说书人 — 后端
 *
 * 职责：
 *  1. 代理 DeepSeek API（API Key 只存后端 .env，浏览器永远接触不到）
 *  2. 组装系统提示词（世界观 / 韩立人设 / 叙述风格 / 面板约束 / 输出格式）
 *  3. 解析说书人输出：叙述正文 + 建议选项 + 状态增量 JSON
 *  4. 托管前端静态页面
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const { MILESTONES } = require('./milestones');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const DEFAULT_BASE = 'https://api.deepseek.com'; // 默认供应商：DeepSeek
const DEFAULT_MODEL = 'deepseek-v4-flash'; // 默认模型：ds v4 flash
let DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE;
let MODEL = process.env.MODEL || DEFAULT_MODEL;
let API_KEY = process.env.DEEPSEEK_API_KEY || '';

if (!API_KEY) {
  console.warn('[提示] 未配置 DEEPSEEK_API_KEY，可在页面点击「密钥」按钮配置（会写入 .env），或编辑 .env 后重启。');
}

// ================= 供应商配置（页面 UI 写入 .env） =================
const ENV_PATH = path.join(__dirname, '.env');

function maskKey(k) {
  if (!k) return null;
  return k.length > 10 ? `${k.slice(0, 6)}****${k.slice(-4)}` : '****';
}

// 将 base_url / api_key / model 写入 .env（缺失行则追加，已有行则替换）
function persistEnv({ baseUrl, apiKey, model }) {
  try {
    const fs = require('fs');
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const upsert = (key, val) => {
      const line = `${key}=${val}`;
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(content)) {
        content = content.replace(re, line);
      } else {
        content = content.replace(/\s*$/, '\n') + line + '\n';
      }
    };
    upsert('DEEPSEEK_BASE_URL', baseUrl);
    upsert('DEEPSEEK_API_KEY', apiKey);
    upsert('MODEL', model);
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    return true;
  } catch (e) {
    console.warn('[写 .env 失败，配置仅保存在内存]', e.message);
    return false;
  }
}

// ================= 系统提示词 =================
// 回复模式：详细（默认）丰满叙述；简略只交代关键事件，但剧情推进规则不变
// 模式指令为最高优先级，覆盖基础长度规则
const REPLY_MODES = {
  detailed:
    '【回复模式：详细（最高优先级，覆盖其他一切长度要求）】本轮叙述 300~600 字，细节、氛围、心理描写尽量丰满，切勿过短。',
  brief:
    '【回复模式：简略（最高优先级，覆盖其他一切长度要求）】本轮叙述控制在 120~160 字，围绕本回合的关键事件写一段完整、自然收尾的叙述——必须有结尾，禁止写到一半；不铺陈环境细节，不做多余心理描写，对话从简；即使此前回合的回复较长，本轮也必须从简。剧情推进、状态变化、选项与 milestone/beat 规则一律照常，不得因简略而跳过应有的剧情进展。',
};

function buildSystemPrompt({ state, summary, pastLife, mode = 'detailed' }) {
  const curIdx = clampMilestone(state.milestone);
  const cur = MILESTONES[curIdx - 1];
  const timeline = MILESTONES.map((m) => `${m.id}. ${m.title}（${m.vol}）：${m.hint}`).join('\n');

  const parts = [
    `你是一位资深的仙侠小说说书人，正在为玩家讲述《凡人修仙传·人界篇》的故事，玩家扮演主角韩立。

【世界设定·背景知识】
- 凡人界修炼体系：炼气期（1~13层）→ 筑基 → 结丹 → 元婴 → 化神 → 飞升灵界。
- 韩立：出身贫寒山村青牛镇五里沟，资质平庸（四灵根），身怀一件神秘旧物——小绿瓶（掌天瓶），可催熟灵草、滴出灵液。这是他最大的秘密，从不示人，前期他甚至不知其真正价值。
- 韩立性格：谨慎、隐忍、藏拙、步步为营，遇事先想退路，人不犯我我不犯人。
- 重要人物（按剧情需要出现）：厉飞雨（同门挚友）、张铁（同门）、墨彩环（墨大夫之女）、墨凤舞、南宫婉（掩月宗女修）、元瑶、紫灵等。
- 主线以原著为准绳：重要事件与人物命运尽量与原著一致；玩家的自由度体现在过程与细节，而非大节拍。

【人界篇剧情轨道·里程碑（主线节点）】
当前主线节点：第 ${curIdx} 个「${cur.title}」（${cur.vol}）
本节点关键事件：${cur.hint}

规则（自由度设计）：
- 【过程完全自由】在抵达下一主线节点之前，玩家可以自由探索、发展支线、游历坊市、经营营生、结交人物、做任何事。你要跟随玩家的行动自由发挥，不得把剧情强行拉回主线，不得否定或改写玩家的自由行动。支线经历可以很精彩、可以改变人物关系、可以带来机缘，只要不颠倒主线节点的顺序。
- 【节点顺序必须遵守】只有主线节点的完成顺序不可颠倒或跳过：未识破墨大夫夺舍阴谋就离开七玄门加入黄枫谷、未结丹就结婴等，均属顺序颠倒，绝不允许。玩家可以先做支线、再回来完成节点，但顺序不变。
- 支线/自创剧情不能充当主线节点的关键事件：只有原著主线事件真正发生（如墨大夫本人收韩立为徒、夺舍阴谋真正败露、墨大夫之祸真正了结、真的进入黄枫谷/乱星海）才算完成节点；玩家自创的类似情节（掌教密谈、杀死其他人物、坊市偶遇等）一律不推进里程碑。
- 每轮叙述前自检：当前节点的关键事件是否已完成？若已完成，在【状态】中输出 milestone（下一个编号，一次只能推进一个）；未完成则省略该字段。
- 收徒完成、阴谋败露、了结墨大夫、拜入黄枫谷、禁地试炼结束、筑基/结丹/结婴成功、飞升等关键节点，都是必须上报的推进信号。
- 若一轮叙述跨越了多个里程碑，只上报第一个完成的里程碑，其余留待后续自然展开。
- 自由探索/支线阶段，beat 字段使用「支线」「坊市」「游历」等自由词即可（不会推进里程碑），不必强行套用主线阶段词。
- 里程碑总表（供你把握全局进度）：
${timeline}

【叙述要求】
- 回复长度以"回复模式"指令为准（见下），该指令优先级最高，基础规则不与之冲突。
- 用第三人称讲述韩立的经历，风格参考凡人修仙传原著：古风白话、细节丰富、氛围感强、张弛有度。
- ${REPLY_MODES[mode] || REPLY_MODES.detailed}
- 用空行分段。玩家的输入可以是行动、对话或选择，你要合理回应并推进剧情。
- 把握韩立的性格：谨慎、算计、藏拙；他绝不高调、绝不轻易暴露秘密。
- 修炼、突破、战斗的描写要有"凡人流"的味道：资源、寿元、风险的权衡。
- 严禁在叙述正文中出现任何元信息、注记或写作说明（如"此处出自原著""请保持设定"之类），一切附加说明只允许出现在【选项】或【状态】区。
- 玩家说"故事开始"时，从韩立随三叔来到七玄门、等待明日入门测试的场景开讲。

【世界状态约束（重要）】
- 玩家界面有状态面板，每次请求都会附带当前世界状态。你的叙述必须与状态一致，不得出现矛盾（如状态为炼气三层，就不能写筑基成功）。
- 推进剧情时合理改变状态：突破提升境界、战斗或交易增减灵石、获得或消耗物品、岁月流逝消耗寿元。

【输出格式（严格遵守，三部分按顺序）】
1. 叙述正文：若干段落，空行分隔。
2. 建议选项（可选）：先输出一行【选项】，随后恰好 3 行，每行一个选项，以 "- " 开头。若玩家当前选择空间不大，可省略。
3. 状态增量（必须输出，最后一行）：【状态】后跟一个 JSON 对象，只包含【发生变化】的字段，字段名固定为：
   {"realm":"境界","lifespan":寿元数字,"spiritStones":灵石数字,"location":"地点","items":["完整物品列表"],"dead":false,"deathReason":"死亡原因","milestone":下一个里程碑编号,"beat":"阶段词"}
   - 字段未变化就省略；items 变化时必须给出完整列表（不是增量）。
   - 韩立死亡时：dead 必须为 true，并写清 deathReason；叙述中写出死亡场景。
   - beat（必填，每轮必须输出）：用 1~2 个词说明当前剧情所处阶段，从以下词汇中选择最贴近的（也可用含义相近的词）：入门测试、杂役、收徒、起疑、识破、了结、离开、入谷、禁地、筑基、出海、结丹、回天南、大晋、元婴、化神、飞升；若剧情处于自由探索/支线阶段（不在上述主线阶段中），可用「支线」「坊市」「游历」「经营」等自由词，不会推进里程碑。
   - milestone（可选）：仅当剧情自然推进到下一个里程碑时输出，值为下一个里程碑编号；一次只能推进一个。
   - 即使无任何变化，也必须输出【状态】行，如：{"dead":false,"beat":"杂役"}`,
  ];

  if (summary) {
    parts.push(`\n【大事记摘要】（此前剧情进展，叙述必须与摘要一致，不得矛盾）\n${summary}`);
  }
  if (pastLife) {
    parts.push(`\n【转世设定】这是韩立的转世新局：他带着上一世残存的模糊记忆（上一世死于：${pastLife}）。开场及后续请用"似曾相识"的笔法暗示这份记忆（既视感、梦境、直觉），让玩家有机会避开上世的死因。不要直接点破"重生"二字，点到为止。`);
  }
  parts.push(`\n【当前世界状态】\n${JSON.stringify(state, null, 2)}`);

  return parts.join('\n');
}

// 非流式调用 DeepSeek（summarize / beat 提取 / 简略结构化补全）
async function callDeepSeek(messages, { temperature = 1.0, maxTokens = 2500, thinking = true } = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (thinking === false) body.thinking = { type: 'disabled' };
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API ${resp.status}: ${bodyText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  if (content.trim()) return content;
  console.warn('[DeepSeek 返回空内容，重试一次]');
  // 偶发空内容：重试一次
  const retryBody = { ...body, thinking: thinking === false ? { type: 'disabled' } : undefined };
  if (retryBody.thinking === undefined) delete retryBody.thinking;
  const resp2 = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(retryBody),
  });
  const data2 = await resp2.json().catch(() => ({}));
  return data2.choices?.[0]?.message?.content ?? '';
}

// 简略模式两段式补全：由短叙述生成完整【选项】+【状态】（含 beat）
async function completeBriefFormat(narrativeText, state) {
  const narrative = String(narrativeText || '').trim();
  try {
    const structPrompt = [
      '你是《凡人修仙传》互动小说的剧情结构化器。请根据以下本轮剧情叙述与当前世界状态，只输出两部分，不要输出任何叙述文字：',
      '1. 【选项】恰好 3 个玩家下一步可做的建议选项，每行一个，以 "- " 开头。',
      '2. 【状态】后跟一个 JSON 对象，只包含【有变化】的字段，字段名固定为：{"realm":"境界","lifespan":寿元数字,"spiritStones":灵石数字,"location":"地点","items":["完整物品列表"],"dead":false,"deathReason":"死亡原因","milestone":下一里程碑编号,"beat":"阶段词"}。',
      '- beat 必填：从以下词中选最贴近当前剧情阶段的：入门测试、杂役、收徒、起疑、识破、了结、离开、入谷、禁地、筑基、出海、结丹、回天南、大晋、元婴、化神、飞升。',
      '- 若剧情中韩立死亡，dead 必须为 true 并写明 deathReason。',
      '- 若当前里程碑的关键事件已完成，milestone 输出下一个编号（一次一个）。',
      `【当前世界状态】\n${JSON.stringify(state)}`,
      `【本轮剧情叙述】\n${narrative}`,
    ].join('\n');
    const structRaw = await callDeepSeek(
      [
        { role: 'system', content: '你只输出【选项】与【状态】两段，严格遵守格式，不输出其他任何内容。' },
        { role: 'user', content: structPrompt },
      ],
      { temperature: 0.4, maxTokens: 400, thinking: false }
    );
    const struct = parseNarration(structRaw);
    return {
      narrative,
      options: Array.isArray(struct.options) && struct.options.length ? struct.options : parsed.options,
      stateDiff: Object.keys(struct.stateDiff).length ? struct.stateDiff : parsed.stateDiff,
    };
  } catch (e) {
    console.warn('[简略结构化补全失败，回退单段解析]', e.message);
    return parsed;
  }
}

// 流式调用 DeepSeek：逐块回调增量文本（onDelta），返回完整内容
// thinking=false 时关闭推理（简略模式：更快、max_tokens 成为硬性长度上限）
async function callDeepSeekStream(messages, onDelta, { temperature = 1.0, maxTokens = 2500, thinking = true } = {}) {
  let lastContent = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = {
      model: MODEL,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };
    if (thinking === false) body.thinking = { type: 'disabled' };
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`DeepSeek API ${resp.status}: ${body.slice(0, 300)}`);
    }

    let content = '';
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          const delta = evt.choices?.[0]?.delta?.content || '';
          if (delta) {
            content += delta;
            onDelta(delta);
          }
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
    if (content.trim()) {
      lastContent = content;
      break;
    }
    console.warn(`[DeepSeek 流式返回空内容，第 ${attempt} 次后重试]`);
    await new Promise((r) => setTimeout(r, 800));
  }
  return lastContent;
}

// ================= 解析说书人输出 =================
function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// 里程碑编号钳制到合法范围 [1, 14]
function clampMilestone(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(Math.max(v, 1), MILESTONES.length);
}

// 里程碑推进校验：只允许按顺序 +1，跳跃则钳制，回退/重复则忽略
function validateMilestone(current, reported) {
  const cur = clampMilestone(current);
  const target = Math.round(Number(reported));
  if (!Number.isFinite(target) || target <= cur) return { milestone: cur, advanced: false };
  const next = Math.min(cur + 1, MILESTONES.length);
  return { milestone: next, advanced: next > cur };
}

// beat（剧情阶段词）→ 所在里程碑编号。
// AI 每轮必填 beat，引擎据此判断剧情进度（比条件性的 milestone 字段可靠得多）。
const BEAT_MILESTONE = {
  入门测试: 1,
  杂役: 1,
  收徒: 2,
  起疑: 3,
  识破: 3,
  了结: 4,
  离开: 5,
  入谷: 5,
  禁地: 6,
  筑基: 7,
  出海: 8,
  结丹: 9,
  回天南: 10,
  大晋: 11,
  元婴: 12,
  化神: 13,
  飞升: 14,
};

// ================= 里程碑校验（三层防线） =================

// 状态交叉校验：地点/境界决定里程碑的物理上限（防 AI 虚报进度）
const LOCATION_CAPS = [
  [/七玄门|青牛镇|五里沟/, 4],
  [/黄枫谷/, 7],
  [/乱星海/, 9],
  [/大晋/, 11],
];
const REALM_CAPS = [
  [/凡人/, 5],
  [/炼气/, 6],
  [/筑基/, 9],
  [/结丹/, 11],
  [/元婴/, 13],
  [/化神/, 14],
];
function plausibleMilestone(state) {
  const loc = String(state.location || '');
  const realm = String(state.realm || '');
  let cap = MILESTONES.length;
  for (const [re, c] of LOCATION_CAPS) {
    if (re.test(loc)) {
      cap = Math.min(cap, c);
      break;
    }
  }
  for (const [re, c] of REALM_CAPS) {
    if (re.test(realm)) {
      cap = Math.min(cap, c);
      break;
    }
  }
  return cap;
}

// 叙述关键词锚定：推进到目标里程碑要求剧情文本包含其全部触发词（防自创支线冒充主线节点）
function milestoneKeywordsOk(narrative, targetMilestone) {
  const m = MILESTONES[targetMilestone - 1];
  if (!m || !Array.isArray(m.trigger) || !m.trigger.length) return true;
  return m.trigger.every((re) => re.test(narrative || ''));
}

// 里程碑上下文：本轮叙述 + 最近 3 条 assistant 历史
// （覆盖"事件先叙述、进度后上报"的延迟推进场景；同时让支线冒充主线更容易被识别）
function milestoneContext(history, currentNarrative) {
  const recent = (history || [])
    .slice(-3)
    .filter((t) => t.role === 'assistant')
    .map((t) => String(t.content || '').split('\n【选项】')[0])
    .join('\n');
  return (recent ? recent + '\n' : '') + (currentNarrative || '');
}

// 叙述推断状态：AI 可能漏报地点/境界变化，用叙述中的强信号补足
// （取叙述中最后出现的地点/境界表达，代表剧情最新推进方向）
function inferStateFromNarrative(narrative) {
  const n = narrative || '';
  const s = {};
  const locs = [
    ['黄枫谷', '黄枫谷'],
    ['乱星海', '乱星海'],
    ['大晋', '大晋'],
    ['昆吾山', '大晋'],
  ];
  let lastLoc = null;
  for (const [kw, v] of locs) {
    if (n.lastIndexOf(kw) >= 0) lastLoc = v;
  }
  if (lastLoc) s.location = lastLoc;
  const realms = [
    ['筑基成功', '筑基'],
    ['顺利筑基', '筑基'],
    ['突破筑基', '筑基'],
    ['已筑基', '筑基'],
    ['结成金丹', '结丹'],
    ['结丹成功', '结丹'],
    ['已结丹', '结丹'],
    ['凝结元婴', '元婴'],
    ['结婴成功', '元婴'],
    ['已结婴', '元婴'],
    ['进阶化神', '化神'],
    ['已化神', '化神'],
  ];
  let lastRealm = null;
  for (const [kw, v] of realms) {
    if (n.lastIndexOf(kw) >= 0) lastRealm = v;
  }
  if (lastRealm) s.realm = lastRealm;
  return s;
}

function parseNarration(text) {
  // 提取【状态】行（最后一个 { ... }）
  const stateMatch = text.match(/【状态】\s*(\{[\s\S]*\})/);
  const stateDiff = stateMatch ? safeParseJson(stateMatch[1]) : {};
  const withoutState = stateMatch ? text.slice(0, stateMatch.index) : text;

  // 提取【选项】块
  const optMatch = withoutState.match(/【选项】\s*\n?((?:- .+\n?)+)/);
  const options = optMatch
    ? optMatch[1]
        .split('\n')
        .map((l) => l.replace(/^-\s*/, '').trim())
        .filter(Boolean)
    : [];

  // 剩余为叙述正文
  const narrative = (optMatch ? withoutState.slice(0, optMatch.index) : withoutState).trim();

  return { narrative, options, stateDiff };
}

// ================= 路由 =================

// 健康检查：验证 Key 与模型列表（不消耗 token）
app.get('/api/health', async (_req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, configured: false, status: 401, model: MODEL, error: '未配置 API Key' });
  }
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const data = await resp.json();
    res.json({
      ok: resp.ok,
      configured: true,
      status: resp.status,
      model: MODEL,
      models: (data.data || []).map((m) => m.id),
    });
  } catch (e) {
    res.status(502).json({ ok: false, configured: true, error: String(e.message || e) });
  }
});

// 供应商配置状态（只返回脱敏信息）
app.get('/api/config/status', (_req, res) => {
  res.json({
    ok: true,
    configured: !!API_KEY,
    masked: maskKey(API_KEY),
    baseUrl: DEEPSEEK_BASE,
    model: MODEL,
  });
});

// 保存并验证供应商配置（base_url + api_key + model）：验证通过后写入 .env 并即时生效
app.post('/api/config', async (req, res) => {
  const { clear } = req.body || {};
  if (clear) {
    API_KEY = '';
    persistEnv({ baseUrl: DEFAULT_BASE, apiKey: '', model: DEFAULT_MODEL });
    return res.json({ ok: true, configured: false });
  }
  const baseUrl = String(req.body?.baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_BASE;
  const model = String(req.body?.model || '').trim() || DEFAULT_MODEL;
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: '密钥不能为空' });
  }
  // 先用新配置验证连通性
  try {
    const testResp = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!testResp.ok) {
      if (testResp.status === 401 || testResp.status === 403) {
        return res.status(400).json({ ok: false, error: `密钥无效（API 返回 ${testResp.status}），请检查后重试` });
      }
      return res.status(400).json({ ok: false, error: `配置无法通过验证（API 返回 ${testResp.status}），请检查 base_url 与密钥` });
    }
  } catch (e) {
    return res.status(502).json({ ok: false, error: `无法连接 API（${baseUrl}）：${e.message}` });
  }
  DEEPSEEK_BASE = baseUrl;
  MODEL = model;
  API_KEY = apiKey;
  const persisted = persistEnv({ baseUrl, apiKey, model });
  res.json({ ok: true, persisted, configured: true, masked: maskKey(apiKey), baseUrl, model });
});

// 按句子边界精简叙述（简略模式）：绝不中途截断，结尾必为完整句子
function smartTrim(text, maxLen = 160, minLen = 40) {
  const t = String(text || '').trim();
  if (t.length <= maxLen) return t;
  const window = t.slice(0, maxLen);
  let cut = -1;
  for (let i = window.length - 1; i >= minLen; i--) {
    if ('。！？；!?;…'.includes(window[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut <= 0) cut = window.length; // 兜底：找不到句子边界才硬截
  return window.slice(0, cut).trim();
}

// 说书人主接口（NDJSON 流式）：text 增量 → parsing → done/error
app.post('/api/chat', async (req, res) => {
  const { history = [], state = {}, summary = '', pastLife = null, mode = 'detailed' } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  try {
    const systemPrompt = buildSystemPrompt({ state, summary, pastLife, mode });
    const messages = [{ role: 'system', content: systemPrompt }, ...history];

    // 简略模式：两段式——缓冲生成完整叙述 → 句子边界精简（不截断）→ 流式下发精简文本 → 结构化补全选项/状态
    // 详细模式：单段流式生成 + 解析
    const isBrief = mode === 'brief';
    let parsed;
    let keywordText = ''; // 关键词锚定使用的完整叙述（简略模式用未裁剪的原文）
    if (isBrief) {
      const briefRaw = await callDeepSeekStream(messages, null, { maxTokens: 400, thinking: false });
      keywordText = parseNarration(briefRaw).narrative;
      const briefNarrative = smartTrim(keywordText);
      for (let i = 0; i < briefNarrative.length; i += 24) {
        res.write(JSON.stringify({ type: 'text', delta: briefNarrative.slice(i, i + 24) }) + '\n');
      }
      res.write(JSON.stringify({ type: 'parsing' }) + '\n');
      parsed = await completeBriefFormat(briefNarrative, state);
    } else {
      const raw = await callDeepSeekStream(
        messages,
        (delta) => {
          res.write(JSON.stringify({ type: 'text', delta }) + '\n');
        },
        { maxTokens: 2500, thinking: true }
      );
      res.write(JSON.stringify({ type: 'parsing' }) + '\n');
      parsed = parseNarration(raw);
      keywordText = parsed.narrative;
    }

    // 里程碑推进校验（确定性规则，无模型兜底）：
    // 1. AI 上报的 milestone 编号 + beat 阶段词映射（取更靠后的一个）
    const reportedMs = parsed.stateDiff.milestone;
    const beat = String(parsed.stateDiff.beat || '').trim();
    delete parsed.stateDiff.milestone;
    delete parsed.stateDiff.beat;

    // 剧情上下文（本轮叙述 + 最近历史），供关键词锚定使用
    const ctx = milestoneContext(history, keywordText);

    // 2. 状态交叉校验 + 自愈
    // 回合结束后的状态：AI 上报的 diff + 叙述推断（AI 漏报地点/境界时补足）
    const postState = Object.assign({}, state, parsed.stateDiff, inferStateFromNarrative(ctx));
    const plausible = plausibleMilestone(postState);
    let cur = clampMilestone(state.milestone);
    let corrected = false;
    if (cur > plausible) {
      cur = plausible; // 自愈：里程碑超出状态上限（如旧档虚报进度）则修正
      corrected = true;
    }

    // 3. 关键词锚定（确定性）：推进目标必须被剧情上下文中的主线元素支撑
    // - AI 报了推进信号 → 目标 = min(上报值, 状态上限)
    // - AI 未报（如自由 beat）→ 试探 cur+1：上下文含下一节点触发词则自动推进
    const aiDesired = Math.max(Number(reportedMs) || 0, BEAT_MILESTONE[beat] || 0);
    const target = aiDesired > cur ? Math.min(aiDesired, plausible) : (cur < plausible ? cur + 1 : cur);
    const final = milestoneKeywordsOk(ctx, target) ? target : cur;
    const prog = validateMilestone(cur, final);

    res.write(
      JSON.stringify({
        type: 'done',
        ok: true,
        narrative: parsed.narrative,
        options: parsed.options,
        stateDiff: parsed.stateDiff,
        milestone: prog.milestone,
        milestoneAdvanced: prog.advanced,
        milestoneCorrected: corrected,
        nextMilestone: prog.advanced ? MILESTONES[prog.milestone - 1].title : null,
      }) + '\n'
    );
  } catch (e) {
    console.error('[chat 失败]', e.message);
    res.write(JSON.stringify({ type: 'error', error: String(e.message || e) }) + '\n');
  }
  res.end();
});

// 里程碑总表（供前端显示剧情进度）
app.get('/api/milestones', (_req, res) => {
  res.json({ ok: true, milestones: MILESTONES });
});

// 大事记压缩：把已过期的剧情对话浓缩进摘要
app.post('/api/summarize', async (req, res) => {
  const { summary = '', turns = [] } = req.body || {};
  const content = turns
    .slice(-60) // 一次最多浓缩 60 条，防请求过大
    .map((t) => `${t.role === 'user' ? '玩家' : '说书人'}：${t.content}`)
    .join('\n');
  if (!content) {
    return res.json({ ok: true, summary });
  }
  try {
    const prompt = [
      '你是《凡人修仙传·人界篇》互动小说的剧情书记官。下面是一段已经过去的剧情对话，以及已有的大事记摘要。',
      '请把这段剧情浓缩成 2~4 句要点，与已有摘要合并，输出【更新后的完整大事记摘要】。',
      '要点应包含：剧情阶段进展、关键事件、重要人物关系变化、韩立的境界/宝物/隐患。语言简洁，中文。',
      `【已有摘要】\n${summary || '（无）'}`,
      `【待浓缩剧情】\n${content}`,
    ].join('\n');
    const raw = await callDeepSeek(
      [
        { role: 'system', content: '你是一位严谨的剧情书记官，输出必须与已有摘要保持一致。' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.3, maxTokens: 800 }
    );
    res.json({
      ok: true,
      summary: raw.replace(/^【更新后的完整大事记摘要】\s*/, '').trim(),
    });
  } catch (e) {
    console.error('[summarize 失败]', e.message);
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ================= 静态页面 =================
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`⭐ 凡人修仙传 · AI 说书人已启动：http://localhost:${PORT}`);
  console.log(`   供应商：${DEEPSEEK_BASE} | 模型：${MODEL} | Key：${maskKey(API_KEY) || '未配置（可在页面点击「密钥」按钮配置）'}`);
});
