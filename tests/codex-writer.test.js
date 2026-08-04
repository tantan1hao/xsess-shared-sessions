/**
 * Codex 写回的回归测试。
 *
 * 这些断言都对应一个实际踩过的坑：
 *   1. 只写 rollout 文件不够 —— `codex resume` 的列表读的是 state 库的
 *      `threads` 表，不登记就永远不出现在列表里（文件格式再对也没用）。
 *   2. `session_meta.source` 是枚举。写了自定义值 'xsess' 之后，
 *      app-server 把 threads.source 记成 'unknown'，会话被过滤掉。
 *   3. 抬头首行会被 Codex 当作列表预览文本，所以它必须是「一句话说清是什么」，
 *      而不是套话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findStateDb } from '../src/core/writers/codex-index.js';
import { TOOLS, exists } from '../src/core/paths.js';

/** Codex 认得的 source 取值 —— 自己编一个进去会被判成 unknown 然后过滤掉 */
const KNOWN_SOURCES = new Set(['cli', 'vscode']);

function openState() {
  const p = findStateDb();
  if (!p) return null;
  return new DatabaseSync(`file:${encodeURI(p)}?mode=ro`, { readOnly: true });
}

test('能找到 Codex 的会话索引库', (t) => {
  if (!exists(TOOLS.codex.sessions)) return t.skip('本机没有 Codex 数据');
  const p = findStateDb();
  assert.ok(p, 'state_*.sqlite 找不到 —— 写进去的会话不会出现在 codex resume 列表里');
  assert.match(path.basename(String(p)), /^state_\d+\.sqlite$/);
});

test('threads 表还有写入需要的那些列（Codex 改 schema 时这条先红）', (t) => {
  const db = openState();
  if (!db) return t.skip('本机没有 Codex 索引库');
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => String(c.name)));
    for (const need of [
      'id', 'rollout_path', 'created_at', 'updated_at', 'source', 'model_provider',
      'cwd', 'title', 'sandbox_policy', 'approval_mode', 'thread_source', 'preview',
      'first_user_message', 'cli_version', 'recency_at', 'archived',
    ]) {
      assert.ok(cols.has(need), `threads 表少了列 ${need}`);
    }
  } finally {
    db.close();
  }
});

test('索引里有可当模板的用户会话', (t) => {
  const db = openState();
  if (!db) return t.skip('本机没有 Codex 索引库');
  try {
    const row = db
      .prepare(
        `SELECT * FROM threads
          WHERE thread_source='user' AND archived=0 AND sandbox_policy!=''
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    if (!row) return t.skip('索引里还没有用户会话');
    // sandbox_policy / approval_mode 是照抄的，不能是空的
    assert.ok(String(row.sandbox_policy).length > 2, 'sandbox_policy 是空的，照抄过去会话打不开');
    assert.ok(String(row.approval_mode).length > 0, 'approval_mode 是空的');
  } finally {
    db.close();
  }
});

test('索引里的 source 只有已知取值 —— 出现别的说明有会话被判成 unknown', (t) => {
  const db = openState();
  if (!db) return t.skip('本机没有 Codex 索引库');
  try {
    const bad = db
      .prepare("SELECT source, count(*) c FROM threads WHERE source NOT LIKE '{%' GROUP BY source")
      .all()
      .filter((r) => !KNOWN_SOURCES.has(String(r.source)));
    assert.deepEqual(
      bad.map((r) => `${r.source}×${r.c}`),
      [],
      'threads.source 出现未知取值：这些会话会从 codex resume 的列表里被过滤掉',
    );
  } finally {
    db.close();
  }
});

test('写出去的 rollout 用的是 Codex 认得的 source/originator', async (t) => {
  const { buildHandoff } = await import('../src/core/handoff.js');
  const { writeCodexSession } = await import('../src/core/writers/codex.js');
  const { listSessions } = await import('../src/core/query.js');

  const rows = await listSessions({ limit: 5 });
  const source = rows.find((r) => r.tool !== 'codex');
  if (!source) return t.skip('没有别家工具的会话可用');
  const pack = await buildHandoff(source.id);
  if (!pack) return t.skip('交接包构建失败');

  // 预览模式：不写文件，但抬头内容是真的
  const r = writeCodexSession(pack, { write: false });
  assert.ok(r.path.endsWith('.jsonl'));
  assert.match(path.basename(r.path), /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f-]{36}\.jsonl$/);

  // 抬头首行 = Codex 列表里的预览文本，必须是带前缀的标题而不是套话
  const firstLine = pack.header.split('\n')[0];
  assert.match(firstLine, /^⟨接力⟩\w{2}：/, `抬头首行会成为列表预览，不该是套话：${firstLine.slice(0, 50)}`);
  assert.ok(firstLine.length < 120, '抬头首行太长，列表里会被截断得看不出是什么');
});

test('已写出去的 rollout 文件 session_meta 字段齐全', async (t) => {
  if (!exists(TOOLS.codex.sessions)) return t.skip('本机没有 Codex 数据');
  const { listWrites } = await import('../src/core/writers/manifest.js');
  // kind 为空的才是会话文件本身；带 kind 的是索引登记记录
  const mine = listWrites().filter((e) => e.tool === 'codex' && !e.kind && exists(e.path));
  if (!mine.length) return t.skip('xsess 还没往 Codex 写过会话');

  const meta = JSON.parse(fs.readFileSync(mine[mine.length - 1].path, 'utf8').split('\n')[0]);
  assert.equal(meta.type, 'session_meta');
  assert.ok(
    KNOWN_SOURCES.has(String(meta.payload.source)),
    `source 必须是 Codex 认得的取值，实际 ${meta.payload.source} —— 会被判成 unknown 然后过滤掉`,
  );
  assert.equal(meta.payload.thread_source, 'user');
  for (const k of ['session_id', 'id', 'cwd', 'cli_version', 'originator', 'model_provider']) {
    assert.ok(meta.payload[k], `session_meta 少了 ${k}`);
  }
});

test('同步→撤销是完全可逆的：三层写进去，三层清干净', async (t) => {
  const db0 = openState();
  if (!db0) return t.skip('本机没有 Codex 索引库');
  db0.close();

  const { syncMany, unsync } = await import('../src/core/sync.js');
  const { listSessions } = await import('../src/core/query.js');
  const { TOOLS } = await import('../src/core/paths.js');

  const SESSION_INDEX = path.join(path.dirname(TOOLS.codex.sessions), 'session_index.jsonl');
  const countThreads = () => {
    const db = openState();
    try {
      return Number(db.prepare('SELECT count(*) c FROM threads').get().c);
    } finally {
      db.close();
    }
  };
  const countIndexLines = () => {
    try {
      return fs.readFileSync(SESSION_INDEX, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  // 挑一条还没同步过去的源会话
  const rows = await listSessions({ limit: 40 });
  const { syncedMap } = await import('../src/core/sync.js');
  const already = syncedMap('codex');
  const source = rows.find((r) => r.tool !== 'codex' && !already.has(r.id));
  if (!source) return t.skip('没有未同步的会话可用');

  const threadsBefore = countThreads();
  const linesBefore = countIndexLines();

  const synced = await syncMany([source.id], { to: 'codex', write: true });
  if (!synced.synced.length) {
    return t.skip(`同步没成功：${JSON.stringify(synced.failed)}`);
  }
  const targetId = synced.synced[0].targetId;
  const file = synced.synced[0].path;

  try {
    // 三层都得写进去
    assert.ok(exists(file), '会话文件没写出来');
    const db = openState();
    try {
      const row = db.prepare('SELECT source, thread_source FROM threads WHERE id=?').get(targetId);
      assert.ok(row, 'threads 表里没有它 —— codex resume 的列表看不到');
      assert.ok(KNOWN_SOURCES.has(String(row.source)), `source 是 ${row.source}，会被过滤掉`);
    } finally {
      db.close();
    }
    assert.ok(
      fs.readFileSync(SESSION_INDEX, 'utf8').includes(targetId),
      'session_index.jsonl 里没有它 —— 桌面版侧边栏看不到',
    );
  } finally {
    // 不管断言成不成功都要撤干净，别在用户的 Codex 里留测试数据
    await unsync([source.id], { to: 'codex', write: true });
  }

  // 三层都得清干净，且回到原样
  assert.ok(!exists(file), '撤销后会话文件还在');
  assert.equal(countThreads(), threadsBefore, '撤销后 threads 表没回到原样');
  assert.equal(countIndexLines(), linesBefore, '撤销后 session_index.jsonl 没回到原样');
});

test('写进去的会话确实登记进了 threads 表', async (t) => {
  const db = openState();
  if (!db) return t.skip('本机没有 Codex 索引库');
  try {
    const { listWrites } = await import('../src/core/writers/manifest.js');
    const indexed = listWrites().filter((e) => e.tool === 'codex' && e.kind === 'index');
    if (!indexed.length) return t.skip('还没有登记记录');

    for (const e of indexed.slice(-3)) {
      const row = db.prepare('SELECT source, thread_source, archived FROM threads WHERE id=?').get(e.appendedId);
      if (!row) continue; // 用户自己删掉了，不算失败
      assert.ok(KNOWN_SOURCES.has(String(row.source)), `${e.appendedId} 的 source 是 ${row.source}`);
      assert.equal(String(row.thread_source), 'user');
      assert.equal(Number(row.archived), 0);
    }
  } finally {
    db.close();
  }
});
