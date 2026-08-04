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
/**
 * 会话初始化步。真实会话里 20/41 带它，且**全部固定在 idx=1**
 * （紧跟第一条用户消息）。payload 只有 200 来字节的元数据信封，没有正文。
 * 不补这一条，会话的开头结构和 Antigravity 自己写的对不上。
 */
const STEP_INIT = 98;
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
 * @param {{write?:boolean, allowWhileRunning?:boolean, previewDir?:string|null}} [opts]
 *   allowWhileRunning：明知 Antigravity 在跑也要写。
 *   留这个口子有两个用途：进程检测万一误判时的逃生口，以及沙箱测试。
 *   正常路径下别用 —— 追加的内容很可能被 Antigravity 退出时的缓存覆盖掉。
 *
 *   previewDir：把会话库整个生成到指定目录做**结构演练**，不碰 Antigravity 的
 *   任何文件、不追加索引、不记清单。这是崩过一次之后补的：会话结构对不对，
 *   必须能在写进去之前就验证，而不是等用户点开才知道。
 */
export function writeAntigravitySession(pack, { write = false, allowWhileRunning = false, previewDir = null } = {}) {
  if (!exists(CONVERSATIONS)) {
    throw new Error(`找不到 Antigravity 的会话目录（${CONVERSATIONS}）`);
  }
  if (!exists(SUMMARIES)) {
    // 这个索引文件是 Antigravity 自己管的，它会在某些时刻重建。
    // 文件不在的时候不能凭空造一个 —— 我们没有它的完整 schema，
    // 造出来的很可能让 Antigravity 打不开甚至崩掉。
    throw new Error(
      `Antigravity 的会话索引 ${path.basename(SUMMARIES)} 当前不存在，无法安全写入。\n` +
        '它由 Antigravity 自己维护：正常用一会儿（新建/打开几个会话）让它重建出来，再试。',
    );
  }

  const template = pickTemplate(pack.cwd);
  if (!template) {
    throw new Error('Antigravity 里没有可用作模板的会话 —— 至少需要一条已有会话来照着写');
  }

  const newCascadeId = randomUUID();
  const title = prefixTitle(pack.tool, pack.title);
  const target = path.join(previewDir || CONVERSATIONS, `${newCascadeId}.db`);

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

  // 演练：只生成会话库本身（带完整自检），Antigravity 的目录一个字节都不动。
  // 它在跑也没关系 —— 我们根本不碰它的文件。
  if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    buildConversationDb(template, pack, newCascadeId, target, title);
    return { ...result, preview: true };
  }

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

/** 模板体积上限。模板会被整个复制一份再清空，太大纯属浪费磁盘和时间 */
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;

/**
 * 挑一条又有 summary 记录、又有**结构真能用**的 .db 当模板。
 *
 * 「结构真能用」这几个字是踩坑换来的。上一版只数了各 step_type 的行数，
 * 于是挑中了一个 t23 存在、但它的 `[30,4]` 字段根本不存在的会话
 * （标题步有两种形态：模型另起的标题走 30.4，直接拿首条消息当标题的只有 30.19）。
 * 结果 titleStep 被判成 null，标题步整个没写进去。
 * 所以这里的判定必须和真正取模板时用的是同一个函数。
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
    let size = 0;
    try {
      size = fs.statSync(dbPath).size;
    } catch {
      continue; // .db 不在
    }
    if (size > MAX_TEMPLATE_BYTES) continue;

    const workspace = stringAt(body, SUMMARY_WORKSPACE);
    candidates.push({
      id,
      summaryTitle,
      body,
      dbPath,
      workspace,
      size,
      sameProject: !!(wantUri && workspace && workspace.startsWith(wantUri)),
    });
  }

  // 先排序再逐个开库验证 —— 开库是这里最贵的操作，排在前面的先试，
  // 命中就不用再碰后面的了。同工作区 > 体积小（复制快、VACUUM 快）
  candidates.sort((a, b) => Number(b.sameProject) - Number(a.sameProject) || a.size - b.size);

  /** @type {any} */
  let fallback = null;
  for (const c of candidates) {
    const facts = templateFacts(c.dbPath);
    if (!facts) continue;
    if (!facts.user || !facts.model || !facts.title) continue;
    // t98 只有一半会话带，不是硬性要求；但带着的结构更完整，优先用
    if (facts.init) return c;
    if (!fallback) fallback = c;
  }
  return fallback;
}

/**
 * 模板库里到底有哪些能用的样板。判定用的就是后面真正取模板的那两个函数，
 * 保证「筛选说能用」和「实际取得到」永远一致。
 */
function templateFacts(dbPath) {
  const db = openRo(dbPath);
  try {
    return {
      user: !!pickStepWithText(db, STEP_USER, USER_TEXT),
      model: !!pickStepWithText(db, STEP_MODEL, MODEL_TEXT),
      title: !!pickStepWithText(db, STEP_TITLE, TITLE_TEXT),
      init: !!firstStepOfType(db, STEP_INIT),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 建会话库

function buildConversationDb(template, pack, newCascadeId, target, title) {
  // 从模板库里取各种 step 的样板，以及模型轮次要配的元数据行
  const src = openRo(template.dbPath);
  let userStep, modelStep, titleStep, initStep, meta, genRow, execRow;
  try {
    meta = src.prepare('SELECT * FROM trajectory_meta LIMIT 1').get();
    userStep = pickStepWithText(src, STEP_USER, USER_TEXT);
    modelStep = pickStepWithText(src, STEP_MODEL, MODEL_TEXT);
    titleStep = pickStepWithText(src, STEP_TITLE, TITLE_TEXT);
    initStep = firstStepOfType(src, STEP_INIT);
    genRow = smallestBlobRow(src, 'gen_metadata');
    execRow = smallestBlobRow(src, 'executor_metadata');
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

  // 第一条：交接抬头。这样即使后面的渲染有出入，打开也能看到完整来龙去脉
  const turns = turnsOf(pack);
  const seq = planSteps(turns, { initStep, titleStep });

  // 先按模板文件复制一份，schema 和索引就都对了
  fs.copyFileSync(template.dbPath, target);

  const db = new DatabaseSync(target);
  try {
    db.exec('BEGIN');
    db.prepare('UPDATE trajectory_meta SET trajectory_id=?, cascade_id=?').run(
      newTrajectoryId,
      newCascadeId,
    );
    // 先清空，下面按新会话重建。gen_metadata / executor_metadata 不是清完就算，
    // 它们和 steps 有数量约束，见下面重建那段。
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

    seq.forEach((item, idx) => {
      const tpl = { user: userStep, model: modelStep, init: initStep, title: titleStep }[item.kind];
      let payload = remapUuids(Buffer.from(tpl.step_payload), uuidMap);

      if (item.kind === 'user' || item.kind === 'model') {
        payload = substituteText(payload, item.kind === 'user', item.text, uuidMap);
      } else if (item.kind === 'title') {
        payload = replaceAt(payload, TITLE_TEXT, title);
        // 连带把「生成标题所依据的那条原始消息」换成我们自己的首条消息，
        // 否则模板会话的正文会从这里漏出去
        if (stringAt(payload, TITLE_SOURCE_TEXT) != null) {
          payload = replaceAt(payload, TITLE_SOURCE_TEXT, turns[0]?.text ?? title);
        }
      }
      // init 步没有正文，只有元数据信封 —— 换完 UUID 直接用

      insert.run(
        idx,
        tpl.step_type,
        tpl.status,
        tpl.has_subtrajectory,
        // metadata 列和 payload 的字段 5 是同一份信封，要一起换 UUID
        tpl.metadata ? remapUuids(Buffer.from(tpl.metadata), uuidMap) : null,
        null,
        null,
        null,
        tpl.render_info ? remapUuids(Buffer.from(tpl.render_info), uuidMap) : null,
        payload,
        tpl.step_format,
      );
    });

    // 每个模型轮次配一条 gen_metadata。
    // 这是硬约束，不是可选装饰：41 个真实会话里 32 个满足
    // 「gen_metadata 行数 === step_type=15 数量」，且它的 idx 是**模型轮次序号**
    // （0,1,2…），不是 step 的 idx。上一版把这张表整个 DELETE 掉却照样插入了
    // N 条模型步 —— Antigravity 渲染第 i 轮时按 idx 去查，查空。
    // 现象就是打开会话后崩溃、.db 被清掉。
    const modelCount = seq.filter((s) => s.kind === 'model').length;
    if (genRow && modelCount) {
      const data = remapUuids(Buffer.from(/** @type {Uint8Array} */ (genRow.data)), uuidMap);
      const g = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?,?,?)');
      for (let i = 0; i < modelCount; i++) g.run(i, new Uint8Array(data), data.length);
    }
    // executor_metadata 和模型轮次**不是**一一对应（实测 9 轮只有 3 条），
    // 所以按序号查它的可能性低 —— 保守只留模板的第一条，够结构完整即可。
    if (execRow) {
      const data = remapUuids(Buffer.from(/** @type {Uint8Array} */ (execRow.data)), uuidMap);
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?,?)').run(0, new Uint8Array(data));
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
  // 它会出现在列表里，点开可能直接让 Antigravity 崩掉（实测过一次）。
  verifyWritten(target, seq);
}

/** 交接抬头 + 原始轮次 */
function turnsOf(pack) {
  return [{ role: 'user', text: pack.header }, ...pack.turns];
}

/**
 * 排 steps 的顺序，照着真实会话的形状来：
 *
 *   idx0 t14(用户)  idx1 t98(初始化)  idx2 t15(模型)  idx3 t23(标题)  之后交替…
 *
 * 两个位置是实测定下来的，不是随手放的：
 *   - t98 在 20 个带它的会话里**全部**位于 idx=1
 *   - t23 在 40 个带它的会话里只有 1 个在末尾，其余都落在 idx 2–7，
 *     也就是「第一个模型回复之后」。上一版把它追加到最后，位置是错的。
 *
 * @param {{role:string,text:string}[]} turns
 * @param {{initStep:any, titleStep:any}} tpl
 */
export function planSteps(turns, { initStep, titleStep }) {
  /** @type {{kind:'user'|'model'|'init'|'title', text?:string}[]} */
  const seq = [];
  turns.forEach((turn, i) => {
    seq.push({ kind: turn.role === 'user' ? 'user' : 'model', text: turn.text });
    if (i === 0 && initStep) seq.push({ kind: 'init' });
  });
  if (titleStep) {
    const firstModel = seq.findIndex((s) => s.kind === 'model');
    seq.splice(firstModel >= 0 ? firstModel + 1 : seq.length, 0, { kind: 'title' });
  }
  return seq;
}

/** 取某个 step_type 的第一条（用于没有正文、只有信封的步骤） */
function firstStepOfType(db, stepType) {
  try {
    return db.prepare('SELECT * FROM steps WHERE step_type=? ORDER BY idx LIMIT 1').get(stepType) || null;
  } catch {
    return null;
  }
}

/**
 * 取某张 blob 表里**最小的**那行当样板。
 * gen_metadata 单行能到 138KB（里面是整套工具定义），挑最小的那条既够
 * 结构完整，又不会让每条同步过去的会话都膨胀上百 KB。
 */
function smallestBlobRow(db, table) {
  try {
    const row = db
      .prepare(`SELECT idx, data FROM "${table}" WHERE data IS NOT NULL ORDER BY length(data) LIMIT 1`)
      .get();
    return row && row.data ? row : null;
  } catch {
    return null; // 表不存在
  }
}

/**
 * 写完立刻按**从真实会话统计出来的不变量**自检一遍。
 *
 * 这一版比上一版严得多，是有代价换来的：上一版只数了 steps 行数就放行，
 * 结果写出来的会话结构不完整，Antigravity 打开时崩了、.db 被清掉。
 * 下面每条断言都对应一个实测规律，注释里写了样本数。
 *
 * @param {string} target
 * @param {{kind:string}[]} seq 计划写入的步骤序列
 */
function verifyWritten(target, seq) {
  const db = openRo(target);
  try {
    const q = (sql, ...args) => Number(db.prepare(sql).get(...args).c);

    const n = q('SELECT count(*) c FROM steps');
    if (n !== seq.length) throw new Error(`步骤数不对：期望 ${seq.length}，实际 ${n}`);

    const empty = q(
      'SELECT count(*) c FROM steps WHERE step_payload IS NULL OR length(step_payload) < 32',
    );
    if (empty > 0) throw new Error(`有 ${empty} 条步骤的 payload 是空的`);

    // idx 必须是 0..n-1 连续无洞 —— Antigravity 按序号取步骤
    const gaps = q('SELECT count(*) c FROM steps WHERE idx < 0 OR idx >= ?', n);
    if (gaps > 0 || q('SELECT count(DISTINCT idx) c FROM steps') !== n) {
      throw new Error('steps 的 idx 不是 0..n-1 的连续序列');
    }

    // 41 个真实会话中 32 个满足：gen_metadata 行数 === step_type=15 数量
    const models = q('SELECT count(*) c FROM steps WHERE step_type=?', STEP_MODEL);
    const gen = q('SELECT count(*) c FROM gen_metadata');
    if (gen !== models) {
      throw new Error(`gen_metadata 行数(${gen}) 和模型步数(${models}) 对不上 —— 打开会崩`);
    }

    // 逐条比对写出来的 step_type 和计划的是否一字不差。
    // 这一条把位置类的错误一网打尽 —— 标题步在哪、初始化步在哪，
    // 都由 planSteps 说了算，这里只负责确认「写出来的 === 计划的」。
    const TYPE_OF = { user: STEP_USER, model: STEP_MODEL, init: STEP_INIT, title: STEP_TITLE };
    const rows = db.prepare('SELECT idx, step_type FROM steps ORDER BY idx').all();
    rows.forEach((r, i) => {
      const want = TYPE_OF[seq[i].kind];
      if (Number(r.step_type) !== want) {
        throw new Error(`第 ${i} 步类型不对：计划 ${seq[i].kind}(t${want})，实际 t${Number(r.step_type)}`);
      }
    });

    // 形状约束：标题步必须**紧跟第一条模型回复**。
    // 真实会话里它几乎从不垫底（40 个里只有 1 个），但那是因为真实会话大多有多轮；
    // 只有一问一答的会话，紧跟第一条回复本来就等于末尾。
    // 所以判据是相对位置，不是「是否在末尾」—— 后者会把正常的单轮会话误判成错误。
    const titleAt = seq.findIndex((s) => s.kind === 'title');
    const firstModel = seq.findIndex((s) => s.kind === 'model');
    if (titleAt >= 0 && firstModel >= 0 && titleAt !== firstModel + 1) {
      throw new Error(`标题步位置不对：应在第 ${firstModel + 1} 步（首条模型回复之后），实际第 ${titleAt} 步`);
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
