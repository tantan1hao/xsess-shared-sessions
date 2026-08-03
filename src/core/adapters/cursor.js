/**
 * Cursor 适配器 —— `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
 *
 * 一个 SQLite 库装下全部会话（本机 390MB / 30132 行）。表 `cursorDiskKV`：
 *   composerData:<composerId>            会话本体：name / createdAt / lastUpdatedAt / 消息索引
 *   bubbleId:<composerId>:<bubbleId>     单条消息，type 1=用户 2=AI，正文在 text
 *
 * 消息索引有新旧两套，都要支持：
 *   新：`fullConversationHeadersOnly` 只存顺序和 bubbleId，正文去 bubbleId: 键里取
 *   旧：`conversation` 直接内联整个数组
 *
 * 增量策略：不能拿整个 .db 的 mtime 当水位线 —— 那样 Cursor 一动，35 个会话全部重解。
 * 改成把「每个 composer」当作一个独立的源，用它自己的 lastUpdatedAt 做水位线。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOOLS, TMP_DIR, exists } from '../paths.js';
import { cleanText, makeSession, toIso } from '../model.js';

const TOOL = 'cursor';
const DB_PATH = TOOLS[TOOL].vscdb;

export const adapter = {
  tool: TOOL,
  displayName: TOOLS[TOOL].displayName,

  available() {
    return exists(DB_PATH);
  },

  async discover() {
    if (!exists(DB_PATH)) return [];
    const { db, cleanup } = openVscdb(DB_PATH);
    try {
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all();
      const out = [];
      for (const r of rows) {
        const composerId = String(r.key).slice('composerData:'.length);
        let d;
        try {
          d = JSON.parse(String(r.value));
        } catch {
          continue; // 这条坏了不影响其它会话
        }
        // Cursor 会把删掉的会话留成字面量 "null"，不挡住会在下一行炸
        if (!d || typeof d !== 'object') continue;
        const bubbleCount =
          (d.fullConversationHeadersOnly && d.fullConversationHeadersOnly.length) ||
          (d.conversation && d.conversation.length) ||
          0;
        out.push({
          sourceId: `${TOOL}:${composerId}`,
          path: DB_PATH,
          // 用会话自己的更新时间 + 消息条数当水位线，而不是整库的 mtime
          mtimeMs: Number(d.lastUpdatedAt || d.createdAt || 0),
          size: bubbleCount,
          composerId,
        });
      }
      return out;
    } finally {
      cleanup();
    }
  },

  async parse(src) {
    const { db, cleanup } = openVscdb(DB_PATH);
    try {
      const row = db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${src.composerId}`);
      if (!row) return [];
      const d = JSON.parse(String(row.value));
      if (!d || typeof d !== 'object') return [];

      const messages = d.fullConversationHeadersOnly?.length
        ? readByHeaders(db, src.composerId, d.fullConversationHeadersOnly)
        : readInline(d.conversation || []);

      return [
        makeSession({
          tool: TOOL,
          nativeId: src.composerId,
          title: d.name || d.subtitle || null,
          cwd: cwdOf(d),
          model: modelOf(d),
          startedAt: toIso(d.createdAt),
          updatedAt: toIso(d.lastUpdatedAt || d.createdAt),
          isSubagent: !!(d.isBestOfNSubcomposer || d.subagentInfo),
          sourceId: src.sourceId,
          path: DB_PATH,
          meta: {
            composerId: src.composerId,
            isAgentic: !!d.isAgentic,
            format: d.fullConversationHeadersOnly?.length ? 'headers' : 'inline',
          },
          messages,
        }),
      ];
    } finally {
      cleanup();
    }
  },
};

/** 新格式：按 header 的顺序去 bubbleId: 键里逐条取正文 */
function readByHeaders(db, composerId, headers) {
  const stmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
  const out = [];
  for (const h of headers) {
    if (!h || !h.bubbleId) continue;
    const row = stmt.get(`bubbleId:${composerId}:${h.bubbleId}`);
    if (!row) continue; // Cursor 会清理旧 bubble，索引里留了条目正文却没了
    let b;
    try {
      b = JSON.parse(String(row.value));
    } catch {
      continue;
    }
    const m = toMessage(b, h.createdAt);
    if (m) out.push(m);
  }
  return out;
}

/** 旧格式：conversation 数组直接内联 */
function readInline(conversation) {
  const out = [];
  for (const b of conversation) {
    const m = toMessage(b, b && b.createdAt);
    if (m) out.push(m);
  }
  return out;
}

function toMessage(b, ts) {
  if (!b || typeof b !== 'object') return null;
  const role = b.type === 1 ? 'user' : b.type === 2 ? 'assistant' : 'system';
  let text = cleanText(b.text || '');

  if (!text && b.toolFormerData) {
    const name = b.toolFormerData.name || b.toolFormerData.tool || '工具';
    text = cleanText(`⟨调用 ${name}⟩ ${b.toolFormerData.params || ''}`.trim(), 1500);
    return text ? { role: 'tool', text, ts: toIso(ts), meta: { tool: name } } : null;
  }
  if (!text) return null;
  return { role, text, ts: toIso(ts) };
}

/** 从会话上下文里找项目路径 —— Cursor 不直接存 cwd */
function cwdOf(d) {
  const uri =
    d.workspaceIdentifier?.configPath?.path ||
    d.workspaceIdentifier?.uri?.path ||
    d.context?.fileSelections?.[0]?.uri?.path ||
    d.context?.folderSelections?.[0]?.uri?.path;
  if (!uri) return null;
  // fileSelections 给的是具体文件，取它所在目录
  return d.context?.folderSelections?.[0]?.uri?.path ? uri : path.dirname(uri);
}

function modelOf(d) {
  return d.modelConfig?.modelName || d.modelConfig?.model || null;
}

/**
 * 只读打开。Cursor 正在跑的时候库开着 WAL，
 * `mode=ro` 会正确读到 WAL（`immutable=1` 不会，会读到撕裂的页面 —— 别用）。
 * 真被锁住就整库快照到临时目录再读，宁可多花一两秒也不能写坏用户 390MB 的历史。
 */
function openVscdb(p) {
  try {
    const db = new DatabaseSync(`file:${encodeURI(p)}?mode=ro`, { readOnly: true });
    db.prepare('SELECT 1 FROM cursorDiskKV LIMIT 1').get(); // 真读一次，确认没被锁
    return { db, cleanup: () => db.close() };
  } catch (e) {
    return openViaSnapshot(p, e);
  }
}

function openViaSnapshot(p, cause) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const snap = path.join(TMP_DIR, `${TOOL}-snapshot.vscdb`);
  try {
    fs.copyFileSync(p, snap);
    for (const ext of ['-wal', '-shm']) {
      if (exists(p + ext)) fs.copyFileSync(p + ext, snap + ext);
    }
    const db = new DatabaseSync(`file:${encodeURI(snap)}?mode=ro`, { readOnly: true });
    return {
      db,
      cleanup: () => {
        db.close();
        for (const ext of ['', '-wal', '-shm']) {
          try {
            fs.rmSync(snap + ext, { force: true });
          } catch {
            /* 清不掉就留着，下次覆盖 */
          }
        }
      },
    };
  } catch (e) {
    throw new Error(`打不开 Cursor 库（直读失败: ${cause.message}；快照失败: ${e.message}）`);
  }
}
