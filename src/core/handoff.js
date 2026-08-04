/**
 * 交接包 —— 把一个会话压缩成「另一个工具接手所需的最小上下文」。
 *
 * 刻意不调 LLM 做摘要：这东西要在 MCP 工具调用里同步返回，
 * 而且必须是确定性的（同一个会话每次生成的包完全一样，可以缓存、可以 diff）。
 * 真正的「理解」交给读到这个包的那个 agent —— 它本来就是个 LLM。
 *
 * 所以这里只做结构化抽取：目标、涉及的文件、最后几轮原文。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSession } from './query.js';
import { HANDOFF_DIR, ensureXsessDirs, prefixTitle } from './paths.js';
import { stripInjectedPreamble, oneLine } from './model.js';

const TOOL_LABEL = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity（反重力）',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
};

/**
 * @typedef {Object} HandoffTurn
 * @property {string} role
 * @property {string} text
 *
 * @typedef {Object} HandoffPack
 * @property {string} sessionId
 * @property {string} tool
 * @property {string} toolLabel
 * @property {string} title
 * @property {string|null} cwd
 * @property {string|null} gitBranch
 * @property {string|null} model
 * @property {string|null} goal
 * @property {string[]} files
 * @property {number} turnCount
 * @property {HandoffTurn[]} turns
 * @property {string} header    抬头部分，写回时当第一条用户消息
 * @property {string} markdown  完整交接包
 */

/**
 * @param {string} id 会话 ID 或前缀
 * @param {{maxTurns?:number, maxCharsPerTurn?:number}} [opts]
 * @returns {Promise<HandoffPack|null>}
 */
export async function buildHandoff(id, opts = {}) {
  const { maxTurns = 12, maxCharsPerTurn = 2000 } = opts;

  // 取全量再自己截，交接包要的是「最后几轮」，不是 getSession 默认的掐头留尾
  const s = await getSession(id, { maxMessages: 10_000, roles: ['user', 'assistant', 'unknown'] });
  if (!s) return null;

  const goal = extractGoal(s.messages);
  const files = extractFiles(s.messages);
  const turns = s.messages.slice(-maxTurns);

  const lines = [];
  lines.push(`# 交接：${s.title}`);
  lines.push('');
  lines.push(
    `**来源**：${TOOL_LABEL[s.tool] || s.tool}` +
      (s.model ? ` · ${s.model}` : '') +
      (s.cwd ? ` · \`${s.cwd}\`` : '') +
      (s.gitBranch ? ` · ⎇ ${s.gitBranch}` : ''),
  );
  lines.push(`**时间**：${fmtDate(s.startedAt)} → ${fmtDate(s.updatedAt)}，共 ${s.messageCount} 条消息`);
  lines.push(`**原会话**：\`${s.id}\``);
  lines.push('');

  if (goal) {
    lines.push('## 最初的目标');
    lines.push('');
    lines.push(goal);
    lines.push('');
  }

  if (files.length) {
    lines.push('## 会话里涉及的文件');
    lines.push('');
    for (const f of files.slice(0, 25)) lines.push(`- \`${f}\``);
    if (files.length > 25) lines.push(`- …另有 ${files.length - 25} 个`);
    lines.push('');
  }

  lines.push(`## 最后 ${turns.length} 轮原文`);
  lines.push('');
  for (const m of turns) {
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '?';
    let text = m.text || '';
    if (text.length > maxCharsPerTurn) {
      text = text.slice(0, maxCharsPerTurn) + `\n…⟨本轮截断，原长 ${m.text.length}⟩`;
    }
    lines.push(`**${who}**：${text}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `以上是从 ${TOOL_LABEL[s.tool] || s.tool} 的会话搬过来的上下文。` +
      '请在此基础上接着做，不要重新问一遍已经确定的事。',
  );

  return {
    sessionId: s.id,
    tool: s.tool,
    toolLabel: TOOL_LABEL[s.tool] || s.tool,
    title: s.title,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    model: s.model,
    goal,
    files,
    turnCount: turns.length,
    /** 原始轮次，写回器要用它在目标工具里重建一段真实对话（而不是只塞一坨摘要） */
    turns: turns.map((m) => ({ role: m.role, text: m.text })),
    /** 交接包的抬头部分：来源、目标、文件清单。写回时当作第一条用户消息 */
    header: buildHeader({ s, goal, files }),
    markdown: lines.join('\n'),
  };
}

function buildHeader({ s, goal, files }) {
  const out = [
    // 第一行必须是「一句话说清这是什么」——
    // Codex 的会话列表拿 rollout 里首条用户消息重建预览文本，
    // 抬头第一行是什么，列表里就显示什么。
    // 原来第一行是「以下内容来自 X 的一个会话，现在转到这里继续。」，
    // 列表里满屏都是这句套话，看不出是哪个会话。
    `⟨接力⟩${prefixTitle(s.tool, s.title)}`,
    '',
    `以下内容来自 ${TOOL_LABEL[s.tool] || s.tool} 的一个会话，现在转到这里继续。`,
    `原会话：${s.title}（\`${s.id}\`）`,
    s.cwd ? `工作目录：${s.cwd}` : null,
    `时间：${fmtDate(s.startedAt)} → ${fmtDate(s.updatedAt)}，共 ${s.messageCount} 条消息`,
  ].filter(Boolean);

  if (goal) {
    out.push('', '最初的目标：', goal);
  }
  if (files.length) {
    out.push('', '涉及的文件：', ...files.slice(0, 20).map((f) => `- ${f}`));
  }
  out.push(
    '',
    `下面是那边最后 ${Math.min(s.messageCount, 12)} 轮的原文。请在此基础上接着做，不要重新问一遍已经确定的事。`,
  );
  return out.join('\n');
}

/**
 * 落盘一份，方便 Tier B（Antigravity/Cursor）在 IDE 里 @ 引用
 * @param {HandoffPack} pack
 * @param {string} [dir]
 */
export function writeHandoffFile(pack, dir = HANDOFF_DIR) {
  ensureXsessDirs();
  fs.mkdirSync(dir, { recursive: true });
  const safe = pack.sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(dir, `${safe}.md`);
  fs.writeFileSync(file, pack.markdown, 'utf8');
  return file;
}

/** 目标 = 第一条真实用户输入（剥掉各家注入的上下文块） */
function extractGoal(messages) {
  for (const m of messages) {
    if (m.role !== 'user' || !m.text) continue;
    const t = stripInjectedPreamble(m.text);
    if (t) return t.length > 1200 ? t.slice(0, 1200) + '…' : t;
  }
  return null;
}

/**
 * 从对话里捞文件路径。
 * 只认「像项目文件」的：有扩展名、不是 URL、不在系统临时目录里。
 * 按出现次数排序 —— 被反复提到的文件才是这次工作的重点。
 */
function extractFiles(messages) {
  const counts = new Map();
  const re = /(?:^|[\s`'"(\[])((?:\/|\.\/|~\/)?[\w.\-]+(?:\/[\w.\-]+)+\.[a-zA-Z0-9]{1,8})(?=$|[\s`'")\],:])/g;

  for (const m of messages) {
    if (!m.text) continue;
    for (const match of m.text.matchAll(re)) {
      const p = match[1];
      if (p.startsWith('http')) continue;
      if (/\/(node_modules|\.git|Library\/Caches|var\/folders|T\/Temp)\//.test(p)) continue;
      if (p.length > 200) continue;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);
}

function fmtDate(iso) {
  if (!iso) return '?';
  return iso.slice(0, 16).replace('T', ' ');
}

/** 给 CLI 用的一行摘要 */
export function handoffSummary(pack) {
  return `${TOOL_LABEL[pack.tool] || pack.tool} · ${oneLine(pack.title, 40)} · ${pack.turnCount} 轮`;
}
