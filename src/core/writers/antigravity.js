/**
 * 直写 Antigravity —— 让别家工具的会话出现在它**原生的**
 * Conversation History / Projects 面板里，而不是另开一个侧边栏。
 *
 * ── 为什么这件事是安全的（跟我最初的判断不同）──
 * 我一开始反对直写，理由是「无 schema 的 protobuf，写错就是静默损坏」。
 * 摸清结构之后发现，需要做的不是**改写**，而是**追加**：
 *
 *   1. `agyhub_summaries_proto.pb` 的顶层是纯 `repeated 字段1`
 *      （实测 51 条记录、解析正好覆盖到文件末尾）。
 *      protobuf 的 repeated 就是同一个 tag 重复出现，所以「新增一条」
 *      在字节层面 = 在文件尾部接一段，已有字节一个都不碰。
 *   2. 会话正文写进**新建**的 `conversations/<新uuid>.db`，不动任何已有会话。
 *
 * 安全性因此和 Claude Code / Codex 的写回同级：只新增，不修改。
 *
 * ── 怎么产出合法的 protobuf ──
 * 不从零构造（那要猜对每个字段号和类型，猜错就静默损坏）。
 * 而是拿一条**真实存在**的记录当模板，只替换确切知道含义的字段：
 *   summary:   1 = 会话ID     2.1 = 标题
 *   step 14:   19.2 / 19.3.1 = 用户消息
 *   step 15:   20.1 / 20.8   = AI 回复
 * 其余字节原样搬过去，都是 Antigravity 自己写出来的合法值。
 *
 * 模板里所有 UUID 会统一换成新的，避免和原会话撞 ID。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TOOLS, BACKUP_DIR, ensureXsessDirs, exists, prefixTitle } from '../paths.js';
import { replaceAt, stringAt, replaceUuidBytes, appendRecord, splitFields } from '../protobuf-edit.js';
import { recordWrite } from './manifest.js';
import { openReadOnlySafe } from '../sqlite-open.js';

const AG_ROOT = path.dirname(TOOLS.antigravity.conversations);
const CONVERSATIONS = TOOLS.antigravity.conversations;
const SUMMARIES = path.join(AG_ROOT, 'agyhub_summaries_proto.pb');

/** summary 记录里的字段路径 */
const SUMMARY_ID = [1];
const SUMMARY_TITLE = [2, 1];
const SUMMARY_WORKSPACE = [2, 17, 7];

/** step payload 里的字段路径 */
const USER_TEXT = [19, 2];
const USER_TEXT_RICH = [19, 3, 1];
const MODEL_TEXT = [20, 1];
const MODEL_TEXT_DUP = [20, 8];

const STEP_USER = 14;
const STEP_MODEL = 15;
const STEP_TITLE = 23;
/** 标题步骤里存标题的路径 */
const TITLE_TEXT = [30, 4];
/**
 * 标题步骤里还夹带着「用来生成标题的那条原始用户消息」。
 * 不替换的话，模板会话的内容会跟着漏进新会话里 ——
 * 实测漏出过一整条别的会话的正文。
 */
const TITLE_SOURCE_TEXT = [30, 19];

export function antigravityAvailable() {
  return exists(CONVERSATIONS) && exists(SUMMARIES);
}

/**
 * @param {import('../handoff.js').HandoffPack} pack
 * @param {{write?:boolean, allowWhileRunning?:boolean}} [opts]
 *   allowWhileRunning：明知 Antigravity 在跑也要写。
 *   留这个口子有两个用途：进程检测万一误判时的逃生口，以及沙箱测试。
 *   正常路径下别用 —— 追加的内容很可能被 Antigravity 退出时的缓存覆盖掉。
 */
export function writeAntigravitySession(pack, { write = false, allowWhileRunning = false } = {}) {
  if (!antigravityAvailable()) {
    throw new Error(`找不到 Antigravity 的数据目录（${AG_ROOT}）`);
  }

  const template = pickTemplate(pack.cwd);
  if (!template) {
    throw new Error('Antigravity 里没有可用作模板的会话 —— 至少需要一条已有会话来照着写');
  }

  const newCascadeId = randomUUID();
  const title = prefixTitle(pack.tool, pack.title);
  const target = path.join(CONVERSATIONS, `${newCascadeId}.db`);

  const result = {
    tool: 'antigravity',
    path: target,
    sessionId: newCascadeId,
    title,
    messageCount: pack.turns.length + 1,
    templateFrom: template.summaryTitle,
    templateWorkspace: template.workspace,
    summariesFile: SUMMARIES,
    resumeHint: '在 Antigravity 的 Conversation History 里打开',
  };

  if (!write) return result;

  if (!allowWhileRunning && isAntigravityRunning()) {
    throw new Error(
      'Antigravity 正在运行。它把会话列表缓存在内存里，退出时会覆盖掉我们追加的内容 —— ' +
        '先完全退出 Antigravity（⌘Q），再执行。',
    );
  }

  backupSummaries();
  buildConversationDb(template, pack, newCascadeId, target, title);
  appendSummary(template, newCascadeId, title);

  recordWrite({ tool: 'antigravity', path: target, sourceSession: pack.sessionId });
  recordWrite({
    tool: 'antigravity',
    path: SUMMARIES,
    kind: 'append',
    appendedId: newCascadeId,
    sourceSession: pack.sessionId,
  });
  return result;
}

// ---------------------------------------------------------------- 选模板

/**
 * 挑一条又有 summary 记录、又有可用 .db 的会话当模板。
 *
 * 优先挑**同一个工作区**的：Projects 面板是按工作区 URI 分组的，
 * 而那个 URI 埋在好几层嵌套结构里、长度还不一样，替换它要重算多层长度前缀，
 * 风险远大于收益。挑对模板就等于免费拿到正确的分组。
 */
function pickTemplate(cwd) {
  const file = fs.readFileSync(SUMMARIES);
  const records = splitFields(file)
    .filter((f) => f.field === 1)
    .map((f) => file.subarray(f.valueStart, f.valueEnd));

  const wantUri = cwd ? `file://${encodeURI(cwd)}` : null;
  const candidates = [];

  for (const body of records) {
    const id = stringAt(body, SUMMARY_ID);
    const summaryTitle = stringAt(body, SUMMARY_TITLE);
    if (!id || !summaryTitle) continue;
    const dbPath = path.join(CONVERSATIONS, `${id}.db`);
    if (!exists(dbPath)) continue;
    if (!hasUsableSteps(dbPath)) continue;

    const workspace = stringAt(body, SUMMARY_WORKSPACE);
    candidates.push({ id, summaryTitle, body, dbPath, workspace });
  }
  if (!candidates.length) return null;

  if (wantUri) {
    const sameProject = candidates.find((c) => c.workspace && c.workspace.startsWith(wantUri));
    if (sameProject) return sameProject;
  }
  // 退而求其次：步数最多的那条，模板结构最全
  return candidates.sort((a, b) => stepCount(b.dbPath) - stepCount(a.dbPath))[0];
}

function hasUsableSteps(dbPath) {
  const db = openRo(dbPath);
  try {
    const u = db.prepare('SELECT count(*) c FROM steps WHERE step_type=?').get(STEP_USER);
    const m = db.prepare('SELECT count(*) c FROM steps WHERE step_type=?').get(STEP_MODEL);
    // 标题步骤也必须有：没有它，Antigravity 会拿第一条消息当标题
    const t = db.prepare('SELECT count(*) c FROM steps WHERE step_type=?').get(STEP_TITLE);
    return Number(u.c) > 0 && Number(m.c) > 0 && Number(t.c) > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function stepCount(dbPath) {
  const db = openRo(dbPath);
  try {
    return Number(db.prepare('SELECT count(*) c FROM steps').get().c);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 建会话库

function buildConversationDb(template, pack, newCascadeId, target, title) {
  // 从模板库里取两种 step 的样板
  const src = openRo(template.dbPath);
  let userStep, modelStep, titleStep, meta;
  try {
    meta = src.prepare('SELECT * FROM trajectory_meta LIMIT 1').get();
    userStep = pickStepWithText(src, STEP_USER, USER_TEXT);
    modelStep = pickStepWithText(src, STEP_MODEL, MODEL_TEXT);
    titleStep = pickStepWithText(src, STEP_TITLE, TITLE_TEXT);
  } finally {
    src.close();
  }
  if (!userStep || !modelStep) throw new Error('模板会话里缺少可用的用户/模型步骤');

  const newTrajectoryId = randomUUID();
  // 模板里出现过的所有 UUID 统一换新，免得和原会话撞 ID
  const uuidMap = new Map([
    [String(meta.cascade_id), newCascadeId],
    [String(meta.trajectory_id), newTrajectoryId],
  ]);

  // 先按模板文件复制一份，schema 和索引就都对了
  fs.copyFileSync(template.dbPath, target);

  const db = new DatabaseSync(target);
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE trajectory_meta SET trajectory_id=?, cascade_id=?').run(
      newTrajectoryId,
      newCascadeId,
    );
    // 这些是模型生成过程的元数据，指向旧会话，留着没意义
    for (const t of ['steps', 'gen_metadata', 'executor_metadata', 'parent_references', 'battle_mode_infos']) {
      try {
        db.exec(`DELETE FROM "${t}"`);
      } catch {
        /* 表不存在就算了 */
      }
    }
    // 会话级 blob 里也有 UUID，一并换掉
    try {
      const blob = db.prepare('SELECT id, data FROM trajectory_metadata_blob LIMIT 1').get();
      if (blob && blob.data) {
        const data = remapUuids(Buffer.from(/** @type {Uint8Array} */ (blob.data)), uuidMap);
        db.prepare('UPDATE trajectory_metadata_blob SET data=? WHERE id=?').run(
          new Uint8Array(data),
          /** @type {string} */ (blob.id),
        );
      }
    } catch {
      /* 没这张表 */
    }

    const insert = db.prepare(
      `INSERT INTO steps
       (idx, step_type, status, has_subtrajectory, metadata, error_details,
        permissions, task_details, render_info, step_payload, step_format)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );

    // 第一条：交接抬头。这样即使后面的渲染有出入，打开也能看到完整来龙去脉
    const turns = turnsOf(pack);

    turns.forEach((turn, idx) => {
      const isUser = turn.role === 'user';
      const tpl = isUser ? userStep : modelStep;
      const payload = substituteText(Buffer.from(tpl.step_payload), isUser, turn.text, uuidMap);
      // metadata 列和 payload 的字段 5 是同一份信封，要一起换 UUID
      const metaBlob = tpl.metadata ? remapUuids(Buffer.from(tpl.metadata), uuidMap) : null;

      insert.run(
        idx,
        tpl.step_type,
        tpl.status,
        tpl.has_subtrajectory,
        metaBlob,
        null,
        null,
        null,
        tpl.render_info ? remapUuids(Buffer.from(tpl.render_info), uuidMap) : null,
        payload,
        tpl.step_format,
      );
    });

    // 补一条标题步骤（step_type=23）。
    // 不补的话 Antigravity 找不到标题，会拿第一条消息的完整原文当标题 ——
    // 实测就是这样：写进去的「cc：OCR运行时集成审查」重启后变成了整段交接抬头。
    // 40/42 个真实会话都带这个步骤，它才是 Antigravity 认的标题来源。
    if (titleStep) {
      let p = replaceAt(remapUuids(Buffer.from(titleStep.step_payload), uuidMap), TITLE_TEXT, title);
      // 连带把「生成标题所依据的那条原始消息」换成我们自己的首条消息，
      // 否则模板会话的正文会从这里漏出去
      if (stringAt(p, TITLE_SOURCE_TEXT) != null) {
        p = replaceAt(p, TITLE_SOURCE_TEXT, turns[0]?.text ?? title);
      }
      insert.run(
        turns.length,
        titleStep.step_type,
        titleStep.status,
        titleStep.has_subtrajectory,
        titleStep.metadata ? remapUuids(Buffer.from(titleStep.metadata), uuidMap) : null,
        null,
        null,
        null,
        titleStep.render_info ? remapUuids(Buffer.from(titleStep.render_info), uuidMap) : null,
        p,
        titleStep.step_format,
      );
    }

    db.exec('COMMIT');
    // 把 WAL 收回主文件并切成 DELETE 模式，否则会在 conversations/ 里
    // 留下 .db-wal / .db-shm 两个残片
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode=DELETE');
    // 关键：模板库是整个复制过来的，DELETE 掉所有行之后 SQLite 不会缩容 ——
    // 实测 49.8MB 的模板删空后还是 49.8MB，VACUUM 之后才降到 48KB。
    // 不做这一步，批量同步几百条会话会吃掉几十 GB。
    db.exec('VACUUM');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 忽略 */
    }
    db.close();
    cleanupDbFiles(target); // 建了一半的库不留下
    throw e;
  }
  db.close();
  for (const ext of ['-wal', '-shm']) {
    if (exists(target + ext)) fs.rmSync(target + ext, { force: true });
  }

  // 写完自己解一遍。写出一个打不开的会话，比不写更糟 ——
  // 它会出现在列表里，点开是空的，而且你不知道是哪一步错了。
  verifyWritten(target, turnsOf(pack).length, !!titleStep);
}

/** 交接抬头 + 原始轮次 */
function turnsOf(pack) {
  return [{ role: 'user', text: pack.header }, ...pack.turns];
}

function verifyWritten(target, turnCount, hasTitleStep) {
  const db = openRo(target);
  try {
    const expected = turnCount + (hasTitleStep ? 1 : 0);
    const n = Number(db.prepare('SELECT count(*) c FROM steps').get().c);
    if (n !== expected) {
      throw new Error(`写出来的会话步骤数不对：期望 ${expected}，实际 ${n}`);
    }
    if (hasTitleStep) {
      const t = Number(db.prepare('SELECT count(*) c FROM steps WHERE step_type=?').get(STEP_TITLE).c);
      if (t !== 1) throw new Error('标题步骤没写进去，Antigravity 会拿首条消息当标题');
    }
    const empty = db
      .prepare('SELECT count(*) c FROM steps WHERE step_payload IS NULL OR length(step_payload) < 32')
      .get();
    if (Number(empty.c) > 0) {
      throw new Error(`有 ${empty.c} 条步骤的 payload 是空的`);
    }
  } finally {
    db.close();
  }
}

function cleanupDbFiles(p) {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(p + ext, { force: true });
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 挑一条**正文字段确实存在**的步骤当模板。
 *
 * 不能简单取第一条：同一个 step_type 底下混着好几种形态 ——
 * step_type=14 里有真的用户消息，也有 payload 只剩元数据信封（没有字段 19）的
 * 空系统步骤；step_type=15 里有散文回复，也有纯工具调用。
 * 拿错模板的后果是正文无处可写，写出来的会话是空的。
 */
function pickStepWithText(db, stepType, textPath) {
  let best = null;
  for (const r of db.prepare('SELECT * FROM steps WHERE step_type=? ORDER BY idx').all(stepType)) {
    const text = stringAt(Buffer.from(r.step_payload), textPath);
    if (!text || text.length < 8) continue;
    // status=3 是正常完成，优先；其它状态的步骤渲染方式可能不同
    if (Number(r.status) === 3) return r;
    if (!best) best = r;
  }
  return best;
}

/**
 * 把模板 step 的正文换成我们的内容。
 * 用户消息和模型回复各自在两处出现（一处原文、一处富文本包装），都要换，
 * 否则 Antigravity 渲染时可能用的是没换的那处，显示出模板会话的内容。
 */
function substituteText(payload, isUser, text, uuidMap) {
  let out = remapUuids(payload, uuidMap);
  if (isUser) {
    out = replaceAt(out, USER_TEXT, text);
    if (stringAt(out, USER_TEXT_RICH) != null) out = replaceAt(out, USER_TEXT_RICH, text);
  } else {
    out = replaceAt(out, MODEL_TEXT, text);
    if (stringAt(out, MODEL_TEXT_DUP) != null) out = replaceAt(out, MODEL_TEXT_DUP, text);
  }
  return out;
}

/**
 * UUID 是定长 36 字节 ASCII，等长替换不影响任何长度前缀
 * @param {Buffer} buf
 * @param {Map<string,string>} uuidMap
 */
function remapUuids(buf, uuidMap) {
  let out = buf;
  for (const [from, to] of uuidMap) {
    if (from && to && from.length === to.length) out = replaceUuidBytes(out, from, to);
  }
  return out;
}

// ---------------------------------------------------------------- 追加索引记录

function appendSummary(template, newCascadeId, title) {
  const file = fs.readFileSync(SUMMARIES);

  /** @type {Buffer} */
  let record = replaceUuidBytes(template.body, template.id, newCascadeId);
  record = replaceAt(record, SUMMARY_TITLE, title);

  const next = appendRecord(file, 1, record);

  // 写之前自己解一遍：解析必须正好覆盖到末尾，且原有字节逐字节不变。
  // 这一步不能省 —— 这个文件坏了，整个会话历史面板就空了。
  const fields = splitFields(next);
  const covered = fields.length ? fields[fields.length - 1].valueEnd : 0;
  if (covered !== next.length) {
    throw new Error(`生成的 summaries 文件解析不完整（${covered}/${next.length}），已放弃写入`);
  }
  if (!next.subarray(0, file.length).equals(file)) {
    throw new Error('生成的 summaries 改动了已有字节，已放弃写入');
  }

  writeAtomic(SUMMARIES, next);
}

// ---------------------------------------------------------------- 工具

/** 只读打开模板库，同样不留 -wal / -shm（见 sqlite-open.js） */
function openRo(p) {
  const { db, removeFiles } = openReadOnlySafe(p, { sentinelTable: 'steps' });
  const origClose = db.close.bind(db);
  db.close = () => {
    try { origClose(); } catch { /* 已关 */ }
    removeFiles();
  };
  return db;
}

function isAntigravityRunning() {
  try {
    const out = execFileSync('/bin/ps', ['-eo', 'comm'], { encoding: 'utf8' });
    return /Antigravity\.app\/Contents\/MacOS\/Antigravity/.test(out);
  } catch {
    return false; // 查不到就别拦着，让用户自己判断
  }
}

function backupSummaries() {
  ensureXsessDirs();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `agyhub_summaries_proto.pb.${stamp}.bak`);
  fs.copyFileSync(SUMMARIES, dest);
  return dest;
}

function writeAtomic(p, content) {
  const tmp = `${p}.xsess-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
