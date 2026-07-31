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
const REPLY_MODES = {
  detailed: '【本轮回复模式：详细】叙述 300~600 字，细节、氛围、心理描写尽量丰满。',
  brief: '【本轮回复模式：简略】叙述 80~150 字，只交代本回合的关键事件、转折与要点，节奏紧凑；剧情推进、状态变化、选项与 milestone/beat 规则一律照常，不得因简略而跳过应有的剧情进展。',
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

【人界篇剧情轨道·里程碑（主线约束，最重要）】
当前里程碑：第 ${curIdx} 个「${cur.title}」（${cur.vol}）
本里程碑关键事件：${cur.hint}

规则：
- 剧情必须围绕当前里程碑展开。玩家选择可以改变过程细节，但不得跳到尚未发生的里程碑事件。
- 每轮叙述前先自检：当前里程碑的关键事件是否已经完成？若已完成，必须在本轮【状态】中输出 milestone（下一个编号）；若未完成则省略该字段。
- 收徒完成、阴谋败露、了结墨大夫、拜入黄枫谷、禁地试炼结束、筑基/结丹/结婴成功、飞升等关键节点，都是必须上报的推进信号。
- 当前里程碑的关键事件完成后，一次只能推进一个里程碑。
- 若一轮叙述跨越了多个里程碑，只上报第一个完成的里程碑，其余留待后续自然展开。
- 里程碑严格按顺序推进：不得回退、不得跳跃、不得提前。未识破墨大夫阴谋就离开七玄门、未结丹就结婴等均属重大偏离，绝不允许。
- 里程碑总表（供你把握全局进度）：
${timeline}

【叙述要求】
- 用第三人称讲述韩立的经历，风格参考凡人修仙传原著：古风白话、细节丰富、氛围感强、张弛有度。
- 每轮叙述 200~500 字，用空行分段。玩家的输入可以是行动、对话或选择，你要合理回应并推进剧情。
- 把握韩立的性格：谨慎、算计、藏拙；他绝不高调、绝不轻易暴露秘密。
- 修炼、突破、战斗的描写要有"凡人流"的味道：资源、寿元、风险的权衡。
- ${REPLY_MODES[mode] || REPLY_MODES.detailed}
- 严禁在叙述正文中出现任何元信息、注记或写作说明（如"此处出自原著""请保持设定"之类），一切附加说明只允许出现在【选项】或【状态】区。
- 玩家说"故事开始"时，从韩立随三叔来到七玄门、等待明日入门测试的场景开讲。

【世界状态约束（重要）】
- 玩家界面有状态面板，每次请求都会附带当前世界状态。你的叙述必须与状态一致，不得出现矛盾（如状态为炼气三层，就不能写筑基成功）。
- 推进剧情时合理改变状态：突破提升境界、战斗或交易增减灵石、获得或消耗物品、岁月流逝消耗寿元。

【输出格式（严格遵守，三部分按顺序）】
1. 叙述正文：若干段落，空行分隔。
2. 建议选项（可选）：先输出一行【选项】，随后 3~5 行，每行一个选项，以 "- " 开头。若玩家当前选择空间不大，可省略。
3. 状态增量（必须输出，最后一行）：【状态】后跟一个 JSON 对象，只包含【发生变化】的字段，字段名固定为：
   {"realm":"境界","lifespan":寿元数字,"spiritStones":灵石数字,"location":"地点","items":["完整物品列表"],"dead":false,"deathReason":"死亡原因","milestone":下一个里程碑编号,"beat":"阶段词"}
   - 字段未变化就省略；items 变化时必须给出完整列表（不是增量）。
   - 韩立死亡时：dead 必须为 true，并写清 deathReason；叙述中写出死亡场景。
   - beat（必填，每轮必须输出）：用 1~2 个词说明当前剧情所处阶段，从以下词汇中选择最贴近的（也可用含义相近的词）：入门测试、杂役、收徒、起疑、识破、了结、离开、入谷、禁地、筑基、出海、结丹、回天南、大晋、元婴、化神、飞升。
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

// ================= 调用 DeepSeek =================
async function callDeepSeek(messages, { temperature = 1.0, maxTokens = 2500 } = {}) {
  // 偶发空内容：重试一次（v4-flash 偶有只出推理 token、正文为空的情况）
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`DeepSeek API ${resp.status}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    if (content.trim()) return content;
    console.warn(`[DeepSeek 返回空内容，第 ${attempt} 次后重试]`);
    await new Promise((r) => setTimeout(r, 800));
  }
  return '';
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

// 说书人主接口
app.post('/api/chat', async (req, res) => {
  const { history = [], state = {}, summary = '', pastLife = null, mode = 'detailed' } = req.body || {};
  try {
    const systemPrompt = buildSystemPrompt({ state, summary, pastLife, mode });
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    const raw = await callDeepSeek(messages);
    const parsed = parseNarration(raw);

    // 里程碑推进校验：引擎把关顺序，AI 不得跳跃/回退
    // 双信号：AI 上报的 milestone 编号 + beat 阶段词映射（取更靠后的一个）
    const cur = clampMilestone(state.milestone);
    const reportedMs = parsed.stateDiff.milestone;
    let beat = String(parsed.stateDiff.beat || '').trim();
    delete parsed.stateDiff.milestone;
    delete parsed.stateDiff.beat;

    // 兜底：AI 漏报 beat 时，用一次轻量"阶段判定"调用补齐（比遵守完整输出格式可靠得多）
    if (!beat && parsed.narrative) {
      try {
        const ext = await callDeepSeek(
          [
            {
              role: 'system',
              content:
                '你是剧情阶段判定器。请阅读本轮剧情，从下列词中选出最符合"当前剧情所处阶段"的一个词，只输出该词本身，不要输出任何其他内容（不要引号、标点、解释）：\n入门测试、杂役、收徒、起疑、识破、了结、离开、入谷、禁地、筑基、出海、结丹、回天南、大晋、元婴、化神、飞升',
            },
            { role: 'user', content: '【本轮剧情】\n' + parsed.narrative },
          ],
          { temperature: 0.1, maxTokens: 150 } // 注意：v4-flash 有推理 token，额度太小会只输出推理、正文为空
        );
        beat = ext.trim().replace(/[「」"'“”‘’，。,.！？!?、]/g, '');
      } catch (e) {
        console.warn('[beat 兜底提取失败]', e.message);
      }
    }

    const beatTarget = BEAT_MILESTONE[beat] || 0;
    const desired = Math.max(Number(reportedMs) || 0, beatTarget);
    const prog = validateMilestone(cur, desired);

    res.json({
      ok: true,
      raw,
      ...parsed,
      milestone: prog.milestone,
      milestoneAdvanced: prog.advanced,
      nextMilestone: prog.advanced ? MILESTONES[prog.milestone - 1].title : null,
    });
  } catch (e) {
    console.error('[chat 失败]', e.message);
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
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
