/**
 * 统一会话模型 —— 所有适配器的输出都要归一到这里。
 *
 * 设计原则：只保留「跨工具都有意义」的字段。各家特有的东西（Codex 的 turn_id、
 * Claude 的 parentUuid 链、Cursor 的 bubbleId）塞进 `meta`，需要写回时再用。
 */

/**
 * @typedef {'user'|'assistant'|'system'|'tool'} Role
 *
 * @typedef {Object} UnifiedMessage
 * @property {Role} role
 * @property {string} text        已剥离 base64 / 控制字符的纯文本
 * @property {string|null} [ts]   ISO 时间戳
 * @property {Object} [meta]      工具特有字段（tool_use 名称、model 等）
 *
 * @typedef {Object} UnifiedSession
 * @property {string} id            全局唯一：`<tool>:<nativeId>`
 * @property {string} tool
 * @property {string} nativeId      在原工具里的 ID
 * @property {string} title
 * @property {string|null} cwd
 * @property {string|null} gitBranch
 * @property {string|null} model
 * @property {string|null} startedAt
 * @property {string|null} updatedAt
 * @property {number} messageCount
 * @property {number} charCount
 * @property {boolean} isSubagent   子代理/后台判定会话，默认在列表里折叠
 * @property {string} sourceId
 * @property {string} path          源文件路径
 * @property {Object} meta
 * @property {UnifiedMessage[]} messages
 *
 * @typedef {Object} SourceRef
 * @property {string} sourceId
 * @property {string} path
 * @property {number} mtimeMs
 * @property {number} size
 *
 * @typedef {Object} Adapter
 * @property {string} tool
 * @property {string} displayName
 * @property {() => boolean} available          该工具在本机是否装了/有数据
 * @property {() => Promise<SourceRef[]>} discover
 * @property {(src: SourceRef) => Promise<UnifiedSession[]>} parse
 */

/** 单条消息正文上限，防止某条超长工具输出把索引撑爆 */
export const MAX_MESSAGE_CHARS = 20_000;
/** 单个会话进 FTS 的正文上限 */
export const MAX_BODY_CHARS = 200_000;

/** 控制字符（保留 \t \n \r），逐字符过滤而不是写字面量正则，免得源码里混进不可见字节 */
const CTRL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

export function sessionKey(tool, nativeId) {
  return `${tool}:${nativeId}`;
}

/**
 * 清洗正文：去控制字符、折叠空白、砍掉 base64 大块、截断。
 * base64 那一刀很重要 —— Claude Code 的会话里内嵌整张 PNG，一条能有 2MB。
 */
export function cleanText(input, max = MAX_MESSAGE_CHARS) {
  if (input == null) return '';
  let s = String(input);
  // 连续 200+ 的 base64 字符流几乎必然是内嵌图片/附件，替换掉而不是留着
  s = s.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '⟨base64⟩');
  s = s.replace(CTRL, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = s.slice(0, max) + `…⟨截断，原长 ${s.length}⟩`;
  return s;
}

/** 压成单行短摘要，用于列表标题 */
export function oneLine(input, max = 80) {
  let s = cleanText(input, max * 4)
    .replace(/```[\s\S]*?```/g, '⟨代码⟩')
    // markdown 链接只留文字：URL 又长又没信息量，会把标题挤没
    .replace(/!?\[([^\]]{1,80})\]\((?:[^)]*)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/**
 * 剥掉各家 CLI 在真实用户输入前面注入的上下文块。
 *
 * 不这么做的话标题全是噪音 —— Codex Desktop 会把附件清单
 * （`# Files mentioned by the user:` + 一堆绝对路径）拼在用户那句话前面，
 * 列表里就只剩一排 `# Files mentioned by the user: ## 8f28b9b5…`。
 *
 * 注意：只影响标题推断，消息正文保持原样，那些路径是真上下文，搜索时有用。
 */
export function stripInjectedPreamble(text) {
  let s = String(text || '');
  // XML 风格的注入块（system-reminder / command-name / local-command-stdout …）
  s = s.replace(/<(system-reminder|command-name|command-message|command-args|local-command-[a-z]+)>[\s\S]*?<\/\1>/g, '');
  // Claude Code 恢复会话时的开场白
  s = s.replace(/^Caveat: The messages below were generated[^\n]*\n/, '');

  // xsess 自己写回时插的交接抬头。整段剥掉而不是保留 ——
  // 否则接力过去的会话，标题会变成「⟨会话接力⟩ 以下内容来自…」而不是真正的目标。
  // 剥空之后 deriveTitle 会自动往下找到重放的第一条原始用户消息。
  if (s.startsWith('⟨会话接力⟩')) return '';

  // Codex Desktop 的附件清单：一个标题行 + 随后所有 `## 名字: /绝对路径` 行。
  // 按行走而不是写一条大正则 —— 中间夹着空行，正则里 `\s*` 会把换行吃掉，
  // 后续的 `\n##` 就再也匹配不上（踩过这个坑）。
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^\s*#\s*Files mentioned by the user:/i.test(lines[i])) {
    i++;
    while (i < lines.length && (!lines[i].trim() || /^\s*##\s/.test(lines[i]))) i++;
    s = lines.slice(i).join('\n');
  }

  // 开头孤立的文件路径行（拖文件进来时常见）
  s = s.replace(/^(?:\s*\/[^\s\n]+\n)+/, '');
  return s.trim();
}

/**
 * 从消息里推标题：优先第一条真实用户输入。
 * 各适配器如果能拿到工具自己生成的标题（Claude 的 ai-title、Cursor 的 name），
 * 应该优先用那个，这里只是兜底。
 */
export function deriveTitle(messages, fallback = '(无标题)') {
  for (const m of messages) {
    if (m.role !== 'user' || !m.text) continue;
    const stripped = stripInjectedPreamble(m.text);
    if (!stripped) continue;
    // xsess 自己接力过去的会话：抬头首行就是标题（`⟨接力⟩cc：原标题`），
    // 后面几行是来源说明和上下文摘要。不单独取首行的话，
    // oneLine 会把整段抬头压成一条又长又乱的标题。
    const first = stripped.split('\n', 1)[0];
    const handoff = /^⟨接力⟩\s*(.+)$/.exec(first);
    return oneLine(handoff ? handoff[1] : stripped);
  }
  const firstAny = messages.find((m) => m.text && m.text.trim());
  if (firstAny) return oneLine(stripInjectedPreamble(firstAny.text) || firstAny.text);
  return fallback;
}

/**
 * 进 FTS 索引的角色。
 * 排除 tool（工具输出噪音大、体积翻倍）和 system（各家注入的指令模板）。
 * `unknown` 要收 —— 那是 Antigravity 旧 `.pb` 格式解出来的正文，
 * 分不清谁说的，但内容是真的，不索引就等于丢了。
 */
const SEARCHABLE_ROLES = new Set(['user', 'assistant', 'unknown']);

/** 拼接供 FTS 索引的正文 */
export function buildBody(messages, max = MAX_BODY_CHARS) {
  const parts = [];
  let total = 0;
  for (const m of messages) {
    if (!SEARCHABLE_ROLES.has(m.role)) continue;
    if (!m.text) continue;
    const line = `${m.role === 'user' ? '›' : m.role === 'assistant' ? '‹' : '·'} ${m.text}`;
    total += line.length;
    if (total > max) {
      const room = max - (total - line.length);
      if (room > 0) parts.push(line.slice(0, room));
      break;
    }
    parts.push(line);
  }
  return parts.join('\n');
}

/**
 * 组装一个 UnifiedSession，把重复的字段计算收在一处。
 * @returns {UnifiedSession}
 */
export function makeSession({
  tool,
  nativeId,
  title,
  cwd = null,
  gitBranch = null,
  model = null,
  startedAt = null,
  updatedAt = null,
  isSubagent = false,
  sourceId,
  path: srcPath,
  meta = {},
  messages = [],
}) {
  const charCount = messages.reduce((n, m) => n + (m.text ? m.text.length : 0), 0);
  return {
    id: sessionKey(tool, nativeId),
    tool,
    nativeId,
    title: title && String(title).trim() ? oneLine(title) : deriveTitle(messages),
    cwd,
    gitBranch,
    model,
    startedAt,
    updatedAt,
    messageCount: messages.length,
    charCount,
    isSubagent,
    sourceId,
    path: srcPath,
    meta,
    messages,
  };
}

/** 把各种时间输入统一成 ISO 串；解析不出来就返回 null，不要瞎编 */
export function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    // 秒 vs 毫秒：小于 1e11 的一律当秒（1e11 毫秒 ≈ 1973 年，早于任何 AI 工具）
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
