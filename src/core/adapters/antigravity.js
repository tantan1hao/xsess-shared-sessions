/**
 * Antigravity（反重力）适配器 —— `~/.gemini/antigravity/conversations/<cascadeId>.{db,pb}`
 *
 * 这家最硬：SQLite 里存 protobuf blob，而且没有公开 `.proto`。
 * 但 wire format 自描述，用 protobuf-walk.js 走一遍就能把文本捞出来。
 * 下面的字段路径全部是对着真实数据反推出来的（见 `tests/antigravity.test.js` 的断言）：
 *
 *   字段 5          每一步都有的元数据信封（step id / trajectory id / session id）→ 纯噪音，整个跳过
 *   step_type=14    用户消息，正文在 19.2（19.3 是同一段的富文本包装）
 *   step_type=15    模型轮次：19/20.1 是散文回复（20.8 重复、20.3 是思考链）
 *                   若无散文则是工具调用：20.7.2 工具名、20.7.3 参数 JSON
 *   step_type=23    标题生成步，Antigravity 自己起的会话标题在 30.4
 *   其余 step_type  各类工具（5=write_to_file 7=grep_search 8=view_file
 *                   21=run_command 33=search_web 127=invoke_subagent …）
 *
 * 容错策略：首选路径取不到东西时退回「除信封外最长的几段非噪音文本」。
 * Antigravity 升级重排字段号时，结果会变糙但不会变空 —— 这是刻意的，
 * 索引静默变空比索引变脏难发现得多。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOOLS, exists } from '../paths.js';
import { cleanText, makeSession, toIso } from '../model.js';
import { extractStrings, isNoise, dedupeStrings } from '../protobuf-walk.js';
import { openReadOnlySafe } from '../sqlite-open.js';

const TOOL = 'antigravity';
const ROOT = TOOLS[TOOL].conversations;

/** 每一步都带的元数据信封字段号 */
const ENVELOPE_FIELD = 5;
/** 工具类消息截断得狠一点：它们不进全文索引，留着只为看上下文 */
const TOOL_TEXT_CAP = 1500;

const STEP_USER = 14;
const STEP_MODEL = 15;
const STEP_TITLE = 23;

export const adapter = {
  tool: TOOL,
  displayName: TOOLS[TOOL].displayName,

  available() {
    return exists(ROOT);
  },

  async discover() {
    if (!exists(ROOT)) return [];
    const out = [];
    for (const name of fs.readdirSync(ROOT)) {
      if (!name.endsWith('.db') && !name.endsWith('.pb')) continue;
      const p = path.join(ROOT, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        out.push({ sourceId: `${TOOL}:${p}`, path: p, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* 文件刚被删 */
      }
    }
    return out;
  },

  async parse(src) {
    const nativeId = path.basename(src.path).replace(/\.(db|pb)$/, '');
    const st = statOf(src.path);
    const times = {
      // Antigravity 的时间戳埋在 protobuf 的 Timestamp 子消息里，
      // 解出来不比文件时间更可靠，就直接用文件时间——至少是诚实的
      startedAt: toIso(st && (st.birthtimeMs || st.mtimeMs)),
      updatedAt: toIso(st && st.mtimeMs),
    };

    if (src.path.endsWith('.pb')) return [parseLegacyPb(src, nativeId, times)];
    return [parseDb(src, nativeId, times)];
  },
};

// ---------------------------------------------------------------- .db（当前格式）

function parseDb(src, nativeId, times) {
  const db = openReadOnly(src.path);
  try {
    let cascadeId = null;
    try {
      const meta = db.prepare('SELECT * FROM trajectory_meta LIMIT 1').get();
      if (meta) cascadeId = meta.cascade_id || null;
    } catch {
      /* 老库可能没这张表 */
    }

    const rows = db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all();

    const messages = [];
    let title = null;

    for (const row of rows) {
      // 丢掉元数据信封：这一刀干掉了绝大部分 ID 噪音，且不依赖具体 step_type
      // schema 保证 step_payload 是 BLOB、step_type 是 INTEGER，
      // 但 node:sqlite 的列值静态类型是联合类型，这里显式收窄
      const payload = /** @type {Uint8Array} */ (row.step_payload);
      const stepType = Number(row.step_type);
      const strings = extractStrings(payload).filter((s) => s.path[0] !== ENVELOPE_FIELD);

      if (stepType === STEP_TITLE && !title) {
        const t = pick(strings, (p) => p[0] === 30 && p[1] === 4)[0];
        if (t && !isNoise(t)) title = t;
      }

      const msg = toMessage(stepType, strings);
      if (msg) messages.push(msg);
    }

    return makeSession({
      tool: TOOL,
      nativeId,
      title,
      cwd: workspaceHint(db),
      startedAt: times.startedAt,
      updatedAt: times.updatedAt,
      sourceId: src.sourceId,
      path: src.path,
      meta: { cascadeId, format: 'db', steps: rows.length },
      messages,
    });
  } finally {
    db.close();
  }
}

/** @param {number} stepType @param {{path:number[],text:string}[]} strings */
function toMessage(stepType, strings) {
  if (stepType === STEP_USER) {
    // 精确取 19.2 —— 19 底下还挂着附件 URI 和 `mcp(...)` 权限串，
    // 按前缀 `p[0]===19` 收会把那些一起卷进来
    let texts = pick(strings, (p) => p[0] === 19 && p[1] === 2).filter(usable);
    if (!texts.length) texts = pick(strings, (p) => p[0] === 19).filter(usable);
    const text = cleanText(dedupeStrings(texts).join('\n'));
    return text ? { role: 'user', text } : null;
  }

  if (stepType === STEP_MODEL) {
    // 20.1 是给人看的回复；20.3 是内部思考链，跳过；20.8 是 20.1 的重复
    const prose = pick(strings, (p) => p[0] === 20 && (p[1] === 1 || p[1] === 8)).filter(usable);
    if (prose.length) {
      const text = cleanText(dedupeStrings(prose).join('\n'));
      if (text) return { role: 'assistant', text };
    }
    // 没有散文 → 这一步是工具调用
    const name = pick(strings, (p) => p[0] === 20 && p[1] === 7 && p[2] === 2)[0];
    const args = pick(strings, (p) => p[0] === 20 && p[1] === 7 && p[2] === 3)[0];
    if (name) {
      return {
        role: 'tool',
        text: cleanText(`⟨调用 ${name}⟩ ${args || ''}`.trim(), TOOL_TEXT_CAP),
        meta: { tool: name },
      };
    }
    return fallbackMessage('assistant', strings);
  }

  // 其余全是工具步（结果 / 文件读写 / 命令执行）
  return fallbackMessage('tool', strings, TOOL_TEXT_CAP);
}

/**
 * 首选字段路径没命中时的退路：拿最长的几段非噪音文本。
 * 不追求漂亮，只保证 Antigravity 改版后内容还搜得到。
 */
function fallbackMessage(role, strings, cap) {
  const texts = dedupeStrings(strings.map((s) => s.text).filter(usable))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const text = cleanText(texts.join('\n'), cap);
  return text ? { role, text } : null;
}

function pick(strings, pred) {
  return strings.filter((s) => pred(s.path)).map((s) => s.text);
}

/** 这段文本值得留吗？ */
function usable(s) {
  const t = String(s).trim();
  if (t.length < 3) return false;
  if (isNoise(t)) return false;
  if (t.startsWith('file:///')) return false; // brain 目录里的内部日志路径
  if (/^bot-[0-9a-f-]+$/.test(t)) return false;
  return true;
}

/** trajectory_metadata_blob 里有工作区提示（项目路径，或 "outside-of-project"） */
function workspaceHint(db) {
  try {
    const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
    if (!row || !row.data) return null;
    for (const s of extractStrings(/** @type {Uint8Array} */ (row.data))) {
      if (s.text.startsWith('/') && s.text.length > 3) return s.text;
    }
  } catch {
    /* 表不存在或格式变了 */
  }
  return null;
}

// ---------------------------------------------------------------- .pb（旧格式）

/**
 * 旧的整文件 protobuf。没有 steps 表就没法分轮次，
 * 只能把文本整体捞出来标成 unknown —— 谁说的分不清，但内容是真的，能搜到就有价值。
 */
function parseLegacyPb(src, nativeId, times) {
  let messages = [];
  try {
    const buf = fs.readFileSync(src.path);
    const texts = dedupeStrings(
      extractStrings(buf)
        .filter((s) => s.path[0] !== ENVELOPE_FIELD)
        .map((s) => s.text)
        .filter(usable),
    ).filter((t) => t.length > 12);
    messages = texts.slice(0, 400).map((text) => ({ role: 'unknown', text: cleanText(text) }));
  } catch (e) {
    // 读不动就产出一个空会话，让它在列表里可见（知道有这个会话但内容取不到），
    // 而不是整个源报错消失
    messages = [];
  }

  return makeSession({
    tool: TOOL,
    nativeId,
    title: null,
    startedAt: times.startedAt,
    updatedAt: times.updatedAt,
    sourceId: src.sourceId,
    path: src.path,
    meta: { format: 'pb', legacy: true },
    messages,
  });
}

// ---------------------------------------------------------------- 工具

/**
 * 只读打开，且不在 Antigravity 的目录里留下 -wal / -shm 垃圾文件。
 * 细节见 sqlite-open.js —— `mode=ro` 只读打开也会写伴生文件，实测每次扫描留几十个。
 */
function openReadOnly(p) {
  const { db, removeFiles } = openReadOnlySafe(p, { sentinelTable: 'steps' });
  // 让调用方照常 db.close()，顺手把临时快照清掉。
  // removeFiles 不会反过来调 close —— 那样两边互相调用会直接爆栈。
  const origClose = db.close.bind(db);
  db.close = () => {
    try { origClose(); } catch { /* 已关 */ }
    removeFiles();
  };
  return db;
}

function statOf(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
