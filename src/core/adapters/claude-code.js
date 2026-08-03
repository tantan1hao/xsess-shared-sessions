/**
 * Claude Code 适配器 —— `~/.claude/projects/<slug>/<sessionId>.jsonl`
 *
 * 一个文件 = 一个会话。每行一条记录，公共字段 uuid/parentUuid/sessionId/cwd/
 * gitBranch/slug/version，type 决定内容：
 *   user / assistant        对话正文
 *   attachment              附件（跳过，正文里已有引用）
 *   ai-title / custom-title 标题（ai-title 会重复很多次，取最后一条）
 *   last-prompt             最后一次输入的快照
 *   queue-operation         队列事件，与内容无关
 *
 * 坑：`type:"user"` 不一定是人说的话 —— content 数组里若是 tool_result，
 * 那其实是工具回传，算成用户轮次会让 messageCount 和标题全错。
 */

import fs from 'node:fs';
import { TOOLS, exists } from '../paths.js';
import { readJsonl, walkFiles } from '../jsonl.js';
import { cleanText, makeSession, toIso } from '../model.js';

const TOOL = 'claude-code';
const ROOT = TOOLS[TOOL].projects;

export const adapter = {
  tool: TOOL,
  displayName: TOOLS[TOOL].displayName,

  available() {
    return exists(ROOT);
  },

  async discover() {
    if (!exists(ROOT)) return [];
    return walkFiles(ROOT, (name) => name.endsWith('.jsonl'), { maxDepth: 3 }).map((f) => ({
      sourceId: `${TOOL}:${f.path}`,
      path: f.path,
      mtimeMs: f.mtimeMs,
      size: f.size,
    }));
  },

  /** @param {{sourceId:string, path:string}} src */
  async parse(src) {
    const messages = [];
    let sessionId = null;
    let cwd = null;
    let gitBranch = null;
    let version = null;
    let slug = null;
    let aiTitle = null;
    let customTitle = null;
    let model = null;
    let firstTs = null;
    let lastTs = null;
    let sidechainCount = 0;

    await readJsonl(src.path, (rec) => {
      if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
      if (rec.cwd) cwd = rec.cwd;
      if (rec.gitBranch) gitBranch = rec.gitBranch;
      if (rec.version) version = rec.version;
      if (rec.slug) slug = rec.slug;
      if (rec.timestamp) {
        if (!firstTs) firstTs = rec.timestamp;
        lastTs = rec.timestamp;
      }

      switch (rec.type) {
        case 'ai-title':
          aiTitle = rec.aiTitle; // 重复出现，后写的覆盖前面的
          break;
        case 'custom-title':
          customTitle = rec.customTitle;
          break;
        case 'user':
        case 'assistant': {
          if (rec.isSidechain) sidechainCount++;
          const msg = toMessage(rec);
          if (msg) messages.push(msg);
          if (rec.message && rec.message.model) model = rec.message.model;
          break;
        }
        default:
          break; // attachment / last-prompt / queue-operation 不进正文
      }
    });

    // 没有 sessionId 就用文件名兜底（文件名本身就是 sessionId）
    if (!sessionId) sessionId = src.path.split('/').pop().replace(/\.jsonl$/, '');

    const st = safeStat(src.path);

    return [
      makeSession({
        tool: TOOL,
        nativeId: sessionId,
        title: customTitle || aiTitle,
        cwd,
        gitBranch,
        model,
        startedAt: toIso(firstTs),
        updatedAt: toIso(lastTs) || toIso(st && st.mtimeMs),
        isSubagent: false,
        sourceId: src.sourceId,
        path: src.path,
        meta: { version, slug, sidechainCount },
        messages,
      }),
    ];
  },
};

/**
 * 一条记录 → 一条 UnifiedMessage（一轮 = 一条，不按 content block 拆）。
 * @returns {{role:string,text:string,ts:string|null,meta?:Object}|null}
 */
function toMessage(rec) {
  const m = rec.message;
  if (!m) return null;
  const ts = toIso(rec.timestamp);
  const content = m.content;

  if (typeof content === 'string') {
    const text = cleanText(content);
    if (!text) return null;
    return { role: rec.type === 'user' ? 'user' : 'assistant', text, ts };
  }
  if (!Array.isArray(content)) return null;

  const texts = [];
  const tools = [];
  let hasToolResult = false;

  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (b.text) texts.push(b.text);
        break;
      case 'tool_use':
        tools.push(b.name);
        break;
      case 'tool_result':
        hasToolResult = true;
        texts.push(flattenToolResult(b.content));
        break;
      case 'thinking':
      case 'redacted_thinking':
      case 'image':
      default:
        break; // 思考链和图片不进索引：噪音大、体积大、跨工具没意义
    }
  }

  // tool_result 走的是 type:"user" 但不是人说的话，单独归成 tool 角色
  const role = hasToolResult ? 'tool' : rec.type === 'user' ? 'user' : 'assistant';
  let text = cleanText(texts.filter(Boolean).join('\n'));
  if (!text && tools.length) text = `⟨调用工具: ${tools.join(', ')}⟩`;
  if (!text) return null;

  const meta = {};
  if (tools.length) meta.tools = tools;
  if (rec.isSidechain) meta.sidechain = true;
  return { role, text, ts, meta: Object.keys(meta).length ? meta : undefined };
}

function flattenToolResult(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
