/**
 * 把会话登记进 Codex 的会话索引 —— `~/.codex/state_<n>.sqlite` 的 `threads` 表。
 *
 * ── 为什么必须有这一步 ──
 * `codex resume` 的选择列表读的是这张表，**不是** `sessions/` 目录。
 * 实测：只写 rollout 文件，格式和真实会话逐字段一致，picker 里照样看不到。
 * 光有文件而没有索引记录，等于写了个谁也找不到的会话。
 *
 * ── 为什么这件事比写 Antigravity 安全 ──
 * 这里是普通的 SQLite 表，schema 自描述、字段全是明文，不需要猜任何东西：
 *   - 只 INSERT 一行，不改也不删任何已有行
 *   - 那些属于 Codex 自身配置的字段（sandbox_policy / approval_mode / model …）
 *     照抄一条真实记录，不自己编
 *   - 写前用 VACUUM INTO 备份（这个方法对正在被别的进程使用的库也安全）
 *
 * 版本号写死在文件名里（state_5），Codex 升级会换新文件；
 * 所以这里按 `state_*.sqlite` 找最新的那个，找不到就跳过登记而不是报错 ——
 * rollout 文件本身仍然是有效的，最坏情况是回到「文件在、列表里看不到」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOOLS, BACKUP_DIR, ensureXsessDirs, exists } from '../paths.js';

const CODEX_HOME = path.dirname(TOOLS.codex.sessions);

/** 找当前在用的 state 库：state_<最大数字>.sqlite */
export function findStateDb() {
  try {
    const files = fs
      .readdirSync(CODEX_HOME)
      .map((n) => /^state_(\d+)\.sqlite$/.exec(n))
      .filter(Boolean)
      .map((m) => ({ name: m[0], n: Number(m[1]) }))
      .sort((a, b) => b.n - a.n);
    if (!files.length) return null;
    const p = path.join(CODEX_HOME, files[0].name);
    return exists(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * 登记一条会话。
 *
 * @param {{
 *   id: string, rolloutPath: string, cwd: string, title: string,
 *   firstUserMessage: string, cliVersion: string, at?: Date, write?: boolean
 * }} info
 * @returns {{indexed:boolean, reason?:string, db?:string, backup?:string}}
 */
export function indexCodexThread(info) {
  const { id, rolloutPath, cwd, title, firstUserMessage, cliVersion, at = new Date(), write = false } = info;

  const dbPath = findStateDb();
  if (!dbPath) {
    return { indexed: false, reason: 'Codex 的会话索引库不在（找不到 state_*.sqlite），会话文件已写但列表里看不到' };
  }

  // 先只读探一遍：模板取得到吗？id 撞了吗？
  const probe = new DatabaseSync(`file:${encodeURI(dbPath)}?mode=ro`, { readOnly: true });
  /** @type {any} */
  let template;
  try {
    if (probe.prepare('SELECT 1 c FROM threads WHERE id=?').get(id)) {
      return { indexed: false, reason: `索引里已经有 ${id} 了`, db: dbPath };
    }
    // 拿一条真实的、用户可见的会话当模板：
    // sandbox_policy / approval_mode / model 这些是 Codex 自己的配置，照抄不编
    template = probe
      .prepare(
        `SELECT * FROM threads
          WHERE thread_source='user' AND archived=0 AND sandbox_policy!=''
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
  } catch (e) {
    return { indexed: false, reason: `读 threads 表失败：${e.message}`, db: dbPath };
  } finally {
    probe.close();
  }
  if (!template) {
    return { indexed: false, reason: 'threads 表里没有可参照的用户会话', db: dbPath };
  }

  const sec = Math.floor(at.getTime() / 1000);
  const ms = at.getTime();
  const row = {
    ...template,
    id,
    rollout_path: rolloutPath,
    cwd,
    title,
    preview: title,
    first_user_message: firstUserMessage,
    cli_version: cliVersion,
    created_at: sec,
    updated_at: sec,
    recency_at: sec,
    created_at_ms: ms,
    updated_at_ms: ms,
    recency_at_ms: ms,
    thread_source: 'user',
    // 真实取值只有 'cli' / 'vscode' / subagent 的 JSON。用 cli：
    // 这是我们能确定 Codex 认得的值，编一个 'xsess' 进去可能让它解析失败
    source: 'cli',
    tokens_used: 0,
    has_user_event: 0,
    archived: 0,
    archived_at: null,
    name: null,
    is_pinned: 0,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    git_sha: null,
    git_branch: null,
    git_origin_url: null,
  };

  if (!write) return { indexed: false, reason: '预览模式', db: dbPath };

  const backup = backupStateDb(dbPath);

  const db = new DatabaseSync(dbPath);
  try {
    const cols = Object.keys(row);
    db.prepare(
      `INSERT INTO threads (${cols.map((c) => `"${c}"`).join(',')})
       VALUES (${cols.map(() => '?').join(',')})`,
    ).run(...cols.map((c) => normalize(row[c])));

    // 自检：真的进去了，而且关键字段没被别的默认值盖掉
    const back = db.prepare('SELECT id, rollout_path, title FROM threads WHERE id=?').get(id);
    if (!back || back.rollout_path !== rolloutPath) {
      throw new Error('写完读回来对不上');
    }
  } finally {
    db.close();
  }

  return { indexed: true, db: dbPath, backup };
}

/** 从索引里摘掉（撤销用）。只删 id 完全匹配的那一行。 */
export function unindexCodexThread(id, { write = false } = {}) {
  const dbPath = findStateDb();
  if (!dbPath) return { removed: false, reason: '找不到索引库' };
  if (!write) return { removed: false, reason: '预览模式', db: dbPath };
  const db = new DatabaseSync(dbPath);
  try {
    const info = db.prepare('DELETE FROM threads WHERE id=?').run(id);
    return { removed: Number(info.changes) > 0, db: dbPath };
  } finally {
    db.close();
  }
}

/**
 * VACUUM INTO 备份。
 * 用它而不是 copyFileSync：state 库开着 WAL，直接复制主文件会漏掉
 * 还在 WAL 里没落盘的内容，备份出来是个撕裂的中间状态。
 */
function backupStateDb(dbPath) {
  ensureXsessDirs();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `${path.basename(dbPath)}.${stamp}.bak`);
  const db = new DatabaseSync(`file:${encodeURI(dbPath)}?mode=ro`, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
  return dest;
}

/** node:sqlite 只收 null/number/string/bigint/Uint8Array，布尔和 undefined 要转一下 */
function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
