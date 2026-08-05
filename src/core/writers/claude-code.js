/**
 * 写回 Claude Code —— 生成一个全新的会话文件，让 `claude --resume` 能直接接上。
 *
 * 安全边界（Tier A 的核心承诺）：
 *   - 只 **新建** `~/.claude/projects/<slug>/<新uuid>.jsonl`
 *   - 绝不打开、绝不修改、绝不删除任何已存在的会话文件
 *   - 创建的文件登记在 ~/.xsess/written.jsonl，随时可撤
 *
 * 格式是从真实会话文件反推的：每行一条记录，user/assistant 靠 uuid/parentUuid
 * 串成链，另有 ai-title / last-prompt 两种元数据行（Claude Code 用它们
 * 在 --resume 列表里显示标题和最后一次输入）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TOOLS, encodeClaudeProjectSlug, exists, prefixTitle } from '../paths.js';
import { recordWrite, recordUnwrite, listWrites } from './manifest.js';
import { indexDesktopSession, unindexDesktopSession } from './claude-desktop-index.js';

const PROJECTS = TOOLS['claude-code'].projects;
/** 找不到已装版本时的兜底。写错版本号不影响 resume，只影响统计。 */
const FALLBACK_VERSION = '2.1.187';

/**
 * @param {import('../handoff.js').HandoffPack} pack 交接包
 * @param {{write?:boolean}} opts
 */
export function writeClaudeCodeSession(pack, { write = false } = {}) {
  const cwd = pack.cwd || process.cwd();
  const sessionId = randomUUID();
  const dir = path.join(PROJECTS, encodeClaudeProjectSlug(cwd));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const version = detectVersion();
  // 用源工具的前缀而不是当前工具的：在 Claude Code 的 --resume 列表里，
  // 你要看到的是「这条是从反重力搬来的」（ag：），不是「这是 Claude 的」
  const title = prefixTitle(pack.tool, pack.title);

  const records = [];
  let parentUuid = null;
  const now = Date.now();
  let tick = 0;

  // 会话级的 URL 友好标识，真实会话里每一行都带着同一个值。
  // 从标题派生，跟 Claude Code 自己生成的形状保持一致。
  const slug = toSlug(title, sessionId);

  /**
   * 每条记录的公共字段。
   * 返回类型标成宽松的 Record —— 调用方会按记录类型往上加
   * promptId / origin / message 这些，精确推断反而挡路。
   * @param {string} type
   * @returns {Record<string, any>}
   */
  const base = (type) => ({
    parentUuid,
    isSidechain: false,
    userType: 'external',
    type,
    uuid: randomUUID(),
    timestamp: new Date(now + tick++).toISOString(),
    cwd,
    sessionId,
    version,
    // 交接包没带分支信息时省略这个字段，而不是写空字符串 ——
    // 真实会话这里总有值（分支名或 HEAD），`""` 是「明确声明没有分支」，
    // 跟「不知道」不是一回事
    ...(pack.gitBranch ? { gitBranch: pack.gitBranch } : {}),
    slug,
    // entrypoint 是 Claude Code 认的枚举（本机真实会话 100/100 都是 claude-desktop）。
    // 原来写的是自编的 'xsess-handoff' —— 和 Codex 那次把 source 写成 'xsess'
    // 一样的错：值不认识，会话就从桌面版的侧边栏里被过滤掉。
    // 来源标识由标题前缀（cx：/ ag：…）和 ~/.xsess/written.jsonl 承担。
    entrypoint: 'claude-desktop',
  });

  // 第一条：交接抬头（来源 / 目标 / 文件清单）。
  // origin/promptSource/permissionMode 这几个只出现在会话的第一条用户记录上，
  // 照着真实文件的样子补齐 —— 结构越接近，Claude Code 处理时越不会有意外
  const head = base('user');
  head.promptId = randomUUID();
  head.origin = { kind: 'human' };
  head.promptSource = 'sdk';
  head.permissionMode = 'default';
  head.message = { role: 'user', content: [{ type: 'text', text: pack.header }] };
  records.push(head);
  parentUuid = head.uuid;

  // 然后把原会话最后几轮当成真实对话重放，模型看到的是上下文而不是一坨摘要
  for (const t of pack.turns) {
    const isUser = t.role === 'user';
    const rec = base(isUser ? 'user' : 'assistant');
    if (isUser) {
      rec.promptId = randomUUID();
      rec.message = { role: 'user', content: [{ type: 'text', text: t.text }] };
    } else {
      rec.requestId = `req_xsess_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      rec.message = {
        role: 'assistant',
        model: pack.model || 'unknown',
        id: `msg_xsess_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        type: 'message',
        content: [{ type: 'text', text: t.text }],
      };
    }
    records.push(rec);
    parentUuid = rec.uuid;
  }

  // 标题有两行，作用不一样：
  //   ai-title      模型自己起的标题
  //   custom-title  用户改过的标题 —— **会话列表显示的是这个**
  // 实测同一条会话 aiTitle 是「实现AI IDE共享会话栏」，customTitle 是
  // 「共享会话栏 AI IDE 互通」，而列表里显示的是后者。
  // 只写 ai-title 的话，我们加的来源前缀（cx：/ ag：…）根本露不出来。
  records.push({ type: 'ai-title', aiTitle: title, sessionId });
  records.push({ type: 'custom-title', customTitle: title, sessionId });
  records.push({
    type: 'last-prompt',
    lastPrompt: pack.header.slice(0, 400),
    leafUuid: parentUuid,
    sessionId,
  });

  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  const result = {
    tool: 'claude-code',
    path: file,
    sessionId,
    title,
    messageCount: records.filter((r) => r.type === 'user' || r.type === 'assistant').length,
    resumeHint: `claude --resume`,
  };

  if (!write) return result;

  fs.mkdirSync(dir, { recursive: true });
  if (exists(file)) throw new Error(`目标文件已存在，不覆盖：${file}`); // UUID 撞车，理论上不可能
  fs.writeFileSync(file, content, 'utf8');
  recordWrite({ tool: 'claude-code', path: file, targetId: sessionId, sourceSession: pack.sessionId });

  // 第二层：桌面版侧边栏读的是它自己的 claude-code-sessions 目录，不看 projects/。
  // 不写这一条的话，`claude --resume` 里看得到、Claude 桌面版里看不到。
  const idx = indexDesktopSession({ cliSessionId: sessionId, cwd, title, at: new Date(now), write: true });
  result.indexed = idx.indexed;
  if (idx.indexed) {
    recordWrite({
      tool: 'claude-code',
      path: idx.path,
      kind: 'desktop-index',
      appendedId: sessionId,
      sourceSession: pack.sessionId,
    });
  } else {
    // 登记失败不回滚文件 —— 文件本身有效，只是桌面版侧边栏里看不到
    result.indexWarning = idx.reason;
  }
  return result;
}

/**
 * 标题 → slug。照着 Claude Code 自己生成的形状来：
 * 全小写、非字母数字压成连字符、掐掉首尾的连字符。
 * 中文标题会被压没，这时退回一个带会话 ID 的兜底值 ——
 * 空 slug 比难看的 slug 更容易出问题。
 */
function toSlug(title, fallbackId = '') {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || `session-${String(fallbackId).slice(0, 8) || 'handoff'}`;
}

/**
 * 撤销一次写回。Claude Code 没有额外的索引 —— `claude --resume` 直接扫
 * `~/.claude/projects/` 目录，所以删掉文件就干净了。
 *
 * @param {{targetId:string, path:string}} target
 * @param {{write?:boolean}} [opts]
 */
export function unwriteClaudeCodeSession(target, { write = false } = {}) {
  const removed = [];
  if (target.path && exists(target.path)) {
    removed.push('会话文件');
    if (write) fs.rmSync(target.path, { force: true });
  }
  if (target.targetId) {
    const idx = unindexDesktopSession(target.targetId, { write });
    if (idx.removed) removed.push('桌面版侧边栏');
  }
  if (write) recordUnwrite('claude-code', target);
  return { tool: 'claude-code', targetId: target.targetId, path: target.path, removed };
}

/**
 * 读本机 Claude Code 的版本号，保持写出来的记录跟真实会话一致。
 *
 * 优先读 `~/.claude/sessions/*.json`（正在跑的进程写的运行时状态，
 * 里面的 version 一定是当前版本）。
 *
 * 之前只扫 projects 目录取第一个 .jsonl 的 version，结果被自己污染了：
 * 整批同步之后目录里几百个文件都是 xsess 写的，而它们的 version 又来自
 * 这个函数上一次的兜底值 —— 于是版本号被永久锁在 FALLBACK 上，
 * 跟真实会话对不上。扫目录时要跳过自己写过的文件。
 */
function detectVersion() {
  try {
    const sessDir = path.join(path.dirname(PROJECTS), 'sessions');
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      const v = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')).version;
      if (v) return v;
    }
  } catch {
    /* 没有运行时状态文件，退回扫目录 */
  }

  const ours = ownWrittenFiles();
  try {
    for (const projDir of fs.readdirSync(PROJECTS)) {
      const d = path.join(PROJECTS, projDir);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.jsonl') || ours.has(f)) continue;
        const head = fs.readFileSync(path.join(d, f), 'utf8').slice(0, 200_000).split('\n');
        for (const line of head) {
          try {
            const v = JSON.parse(line).version;
            if (v) return v;
          } catch {
            /* 跳过 */
          }
        }
      }
    }
  } catch {
    /* 目录读不了就用兜底 */
  }
  return FALLBACK_VERSION;
}

/** xsess 自己写过的会话文件名，探测本机真实配置时要跳过它们 */
function ownWrittenFiles() {
  const set = new Set();
  try {
    for (const e of listWrites()) {
      if (e.tool === 'claude-code' && e.path) set.add(path.basename(e.path));
    }
  } catch {
    /* 清单读不了就当没有 */
  }
  return set;
}
