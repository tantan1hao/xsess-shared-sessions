/**
 * 索引库 —— node:sqlite（Node 22+ 内置）+ FTS5 trigram。
 *
 * 选 trigram 而不是默认的 unicode61 分词器，是因为 unicode61 不切中文，
 * 「跨工具会话」会被当成一个词，搜「会话」就搜不到。trigram 按三字滑窗，
 * 中文子串搜索直接可用（代价：查询串至少要 3 个字符，短查询走 LIKE 兜底）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INDEX_DB } from './paths.js';
import { buildBody } from './model.js';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS sources (
  source_id  TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  path       TEXT NOT NULL,
  mtime_ms   REAL NOT NULL,
  size       INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  native_id     TEXT NOT NULL,
  title         TEXT,
  cwd           TEXT,
  git_branch    TEXT,
  model         TEXT,
  started_at    TEXT,
  updated_at    TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  char_count    INTEGER NOT NULL DEFAULT 0,
  is_subagent   INTEGER NOT NULL DEFAULT 0,
  source_id     TEXT NOT NULL,
  path          TEXT,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_tool    ON sessions(tool);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source  ON sessions(source_id);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd     ON sessions(cwd);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  ts         TEXT,
  text       TEXT,
  meta       TEXT,
  PRIMARY KEY (session_id, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  id UNINDEXED, title, body, tokenize='trigram'
);
`;

export function openIndex(file = INDEX_DB, { readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: readonly });
  // 这个库天天有并发：daemon 每 30 秒扫一次、CLI 随时查、侧边栏也在读。
  // 不设等待时间的话，撞上写事务就直接 SQLITE_BUSY 抛出去 ——
  // 用户看到的是「database is locked」，其实等几十毫秒就好了。
  db.exec('PRAGMA busy_timeout=5000');
  if (!readonly) {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
  return new Index(db);
}

class Index {
  /** @param {DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败就让原始异常冒上去，别掩盖它 */
      }
      throw e;
    }
  }

  // ---------- 源（增量扫描的水位线） ----------

  getSource(sourceId) {
    return this.db.prepare('SELECT * FROM sources WHERE source_id=?').get(sourceId);
  }

  /** 源没变过就不用重新解析 */
  isFresh(src) {
    const prev = this.getSource(src.sourceId);
    return !!prev && prev.ok === 1 && prev.mtime_ms === src.mtimeMs && prev.size === src.size;
  }

  markSourceError(src, tool, err) {
    this.db
      .prepare(
        `INSERT INTO sources(source_id,tool,path,mtime_ms,size,indexed_at,ok,error)
         VALUES(?,?,?,?,?,?,0,?)
         ON CONFLICT(source_id) DO UPDATE SET
           mtime_ms=excluded.mtime_ms, size=excluded.size,
           indexed_at=excluded.indexed_at, ok=0, error=excluded.error`,
      )
      .run(
        src.sourceId,
        tool,
        src.path,
        src.mtimeMs,
        src.size,
        new Date().toISOString(),
        String(err && err.message ? err.message : err).slice(0, 1000),
      );
  }

  /**
   * 用一个源的最新解析结果整体替换旧数据。
   * 先删后插，避免源里的会话被删掉后索引里还留着幽灵。
   */
  replaceSource(src, tool, sessions) {
    this.transaction(() => {
      this.#deleteSessionsOfSource(src.sourceId);
      for (const s of sessions) this.#insertSession(s);
      this.db
        .prepare(
          `INSERT INTO sources(source_id,tool,path,mtime_ms,size,indexed_at,ok,error)
           VALUES(?,?,?,?,?,?,1,NULL)
           ON CONFLICT(source_id) DO UPDATE SET
             mtime_ms=excluded.mtime_ms, size=excluded.size,
             indexed_at=excluded.indexed_at, ok=1, error=NULL`,
        )
        .run(src.sourceId, tool, src.path, src.mtimeMs, src.size, new Date().toISOString());
    });
  }

  /**
   * 清掉某个工具下「源已经不在了」的会话。
   *
   * 没有这一步的话，删掉的会话会永远留在索引里：扫描只看新增和变更，
   * 消失的源不会再被访问，它的记录也就永远不会被更新掉。
   * 表现是侧边栏里点开一个会话，提示文件不存在。
   *
   * @param {string} tool
   * @param {Set<string>} liveSourceIds 本次 discover 到的所有 sourceId
   */
  pruneMissingSources(tool, liveSourceIds) {
    const known = this.db.prepare('SELECT source_id FROM sources WHERE tool=?').all(tool);
    const gone = known.map((r) => String(r.source_id)).filter((id) => !liveSourceIds.has(id));
    if (!gone.length) return 0;
    this.transaction(() => {
      const delSrc = this.db.prepare('DELETE FROM sources WHERE source_id=?');
      for (const id of gone) {
        this.#deleteSessionsOfSource(id);
        delSrc.run(id);
      }
    });
    return gone.length;
  }

  #deleteSessionsOfSource(sourceId) {
    const ids = this.db
      .prepare('SELECT id FROM sessions WHERE source_id=?')
      .all(sourceId)
      .map((r) => r.id);
    const delMsg = this.db.prepare('DELETE FROM messages WHERE session_id=?');
    const delFts = this.db.prepare('DELETE FROM sessions_fts WHERE id=?');
    for (const id of ids) {
      delMsg.run(id);
      delFts.run(id);
    }
    this.db.prepare('DELETE FROM sessions WHERE source_id=?').run(sourceId);
  }

  #insertSession(s) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
         (id,tool,native_id,title,cwd,git_branch,model,started_at,updated_at,
          message_count,char_count,is_subagent,source_id,path,meta)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.tool,
        s.nativeId,
        s.title,
        s.cwd,
        s.gitBranch,
        s.model,
        s.startedAt,
        s.updatedAt,
        s.messageCount,
        s.charCount,
        s.isSubagent ? 1 : 0,
        s.sourceId,
        s.path,
        JSON.stringify(s.meta || {}),
      );

    const insMsg = this.db.prepare(
      'INSERT OR REPLACE INTO messages(session_id,idx,role,ts,text,meta) VALUES(?,?,?,?,?,?)',
    );
    s.messages.forEach((m, i) => {
      insMsg.run(s.id, i, m.role, m.ts ?? null, m.text ?? '', m.meta ? JSON.stringify(m.meta) : null);
    });

    this.db
      .prepare('INSERT INTO sessions_fts(id,title,body) VALUES(?,?,?)')
      .run(s.id, s.title ?? '', buildBody(s.messages));
  }

  // ---------- 查询 ----------

  /**
   * @param {{tool?:string, cwd?:string, limit?:number, offset?:number,
   *          includeSubagents?:boolean, since?:string}} [opts]
   */
  listSessions(opts = {}) {
    const { tool, cwd, limit = 50, offset = 0, includeSubagents = false, since } = opts;
    const where = [];
    const args = [];
    if (tool) {
      where.push('tool=?');
      args.push(tool);
    }
    if (cwd) {
      where.push('cwd=?');
      args.push(cwd);
    }
    if (since) {
      where.push('updated_at>=?');
      args.push(since);
    }
    if (!includeSubagents) where.push('is_subagent=0');
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(updated_at, started_at) DESC LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, limit, offset).map(rowToSession);
  }

  /**
   * 全文搜索。trigram 要求查询串 ≥3 字符，短查询自动降级成 LIKE 扫描。
   * @param {string} q
   */
  searchSessions(q, opts = {}) {
    const { tool, limit = 30, includeSubagents = false } = opts;
    const query = String(q || '').trim();
    if (!query) return [];

    const filter = [];
    const args = [];
    if (tool) {
      filter.push('s.tool=?');
      args.push(tool);
    }
    if (!includeSubagents) filter.push('s.is_subagent=0');
    const filterSql = filter.length ? ' AND ' + filter.join(' AND ') : '';

    if (query.length >= 3) {
      const rows = this.db
        .prepare(
          `SELECT s.*, snippet(sessions_fts, 2, '⟦', '⟧', '…', 24) AS snip, bm25(sessions_fts) AS rank
             FROM sessions_fts f JOIN sessions s ON s.id = f.id
            WHERE sessions_fts MATCH ?${filterSql}
            ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuote(query), ...args, limit);
      if (rows.length) return rows.map((r) => ({ ...rowToSession(r), snippet: r.snip }));
      // trigram 没命中不代表真没有（比如查询里有标点），继续走 LIKE
    }

    const like = `%${query}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT s.* FROM sessions s
           LEFT JOIN messages m ON m.session_id = s.id
          WHERE (s.title LIKE ? OR m.text LIKE ?)${filterSql}
          ORDER BY COALESCE(s.updated_at, s.started_at) DESC LIMIT ?`,
      )
      .all(like, like, ...args, limit)
      .map((r) => ({ ...rowToSession(r), snippet: null }));
  }

  getSession(id, { withMessages = true } = {}) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) return null;
    const s = rowToSession(row);
    if (withMessages) {
      s.messages = this.db
        .prepare('SELECT role,ts,text,meta FROM messages WHERE session_id=? ORDER BY idx')
        .all(id)
        .map((m) => ({
          role: m.role,
          ts: m.ts,
          text: m.text,
          meta: m.meta ? JSON.parse(String(m.meta)) : undefined,
        }));
    }
    return s;
  }

  /** 前缀匹配找会话，方便 CLI 里敲短 ID */
  resolveId(prefix) {
    const exact = this.db.prepare('SELECT id FROM sessions WHERE id=?').get(prefix);
    if (exact) return exact.id;
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE id LIKE ? OR native_id LIKE ? LIMIT 10')
      .all(`%${prefix}%`, `${prefix}%`);
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) {
      const err = new Error(`ID「${prefix}」不唯一，匹配到 ${rows.length} 个`);
      // @ts-ignore 附带候选给调用方展示
      err.candidates = rows.map((r) => r.id);
      throw err;
    }
    return null;
  }

  stats() {
    const byTool = this.db
      .prepare(
        `SELECT tool,
                COUNT(*) AS sessions,
                SUM(is_subagent) AS subagents,
                SUM(message_count) AS messages,
                SUM(char_count) AS chars,
                MAX(COALESCE(updated_at, started_at)) AS latest
           FROM sessions GROUP BY tool ORDER BY sessions DESC`,
      )
      .all();
    const totals = this.db
      .prepare('SELECT COUNT(*) AS sessions, SUM(message_count) AS messages FROM sessions')
      .get();
    const failed = this.db.prepare('SELECT * FROM sources WHERE ok=0').all();
    return { byTool, totals, failed };
  }
}

function rowToSession(r) {
  return {
    id: r.id,
    tool: r.tool,
    nativeId: r.native_id,
    title: r.title,
    cwd: r.cwd,
    gitBranch: r.git_branch,
    model: r.model,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    charCount: r.char_count,
    isSubagent: !!r.is_subagent,
    sourceId: r.source_id,
    path: r.path,
    meta: r.meta ? safeParse(r.meta) : {},
    messages: [],
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * FTS5 的 MATCH 语法会把中文标点、引号当运算符解析并报错。
 * 整串加双引号变成短语查询最省事 —— 内部的双引号按 FTS5 规矩转义成两个。
 */
function ftsQuote(q) {
  return '"' + q.replace(/"/g, '""') + '"';
}
