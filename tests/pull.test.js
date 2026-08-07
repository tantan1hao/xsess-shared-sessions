/**
 * 回流的回归测试。
 *
 * 回流是唯一会往**已存在**的会话文件里写东西的路径，所以两条底线要盯死：
 *   1. 只追加 —— 已有字节一个都不能变
 *   2. 幂等 —— 跑两次不能把同一批消息追加两遍
 *
 * 第二条是真踩过的：源会话被追加了内容，但目标那边的时间戳没变，
 * 再跑一次 findDrift 照样检测到同一批，于是重复追加。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncPairs, pullWatermarks } from '../src/core/pull.js';
import { appendClaudeCodeSession } from '../src/core/writers/claude-code.js';
import { writeClaudeCodeSession } from '../src/core/writers/claude-code.js';
import { unwriteClaudeCodeSession } from '../src/core/writers/claude-code.js';
import { TOOLS, exists } from '../src/core/paths.js';

const readJsonl = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** 造一条真实的会话当靶子，用完撤掉 */
async function makeSession(t) {
  if (!exists(TOOLS['claude-code'].projects)) return t.skip('本机没有 Claude Code 数据');
  const { buildHandoff } = await import('../src/core/handoff.js');
  const { listSessions } = await import('../src/core/query.js');

  let source = null;
  for (const tool of ['codex', 'antigravity', 'cursor', 'gemini-cli']) {
    const rows = await listSessions({ tool, limit: 5 });
    source = rows.find((r) => (r.messageCount || 0) >= 2);
    if (source) break;
  }
  if (!source) return t.skip('没有可用的源会话');
  const pack = await buildHandoff(source.id);
  if (!pack) return t.skip('交接包构建失败');
  return writeClaudeCodeSession(pack, { write: true });
}

test('追加只在文件尾部写，已有字节零改动', async (t) => {
  const s = await makeSession(t);
  if (!s) return;
  try {
    const before = fs.readFileSync(s.path);
    const r = appendClaudeCodeSession(
      s.sessionId,
      [
        { role: 'user', text: '回流测试的问题' },
        { role: 'assistant', text: '回流测试的回答' },
      ],
      { write: true, note: '⟨回流⟩ 测试' },
    );
    assert.equal(r.appended, 3, '抬头 + 两条对话');

    const after = fs.readFileSync(s.path);
    assert.ok(after.length > before.length, '文件该变长');
    assert.ok(
      after.subarray(0, before.length).equals(before),
      '已有字节被改动了 —— 追加必须只在尾部写',
    );
    assert.ok(r.backup && exists(r.backup), '写前该留备份');
  } finally {
    unwriteClaudeCodeSession({ targetId: s.sessionId, path: s.path }, { write: true });
  }
});

test('追加的记录接得上 parentUuid 链，且不引入新断点', async (t) => {
  const s = await makeSession(t);
  if (!s) return;
  try {
    const convOf = (f) => readJsonl(f).filter((x) => x.type === 'user' || x.type === 'assistant');
    const breaksOf = (conv) => {
      const out = [];
      let prev = null;
      conv.forEach((r, i) => {
        if (r.parentUuid !== prev) out.push(i);
        prev = r.uuid;
      });
      return out;
    };

    const before = convOf(s.path);
    const beforeBreaks = breaksOf(before);

    appendClaudeCodeSession(s.sessionId, [{ role: 'user', text: '接上来的一句' }], { write: true });

    const after = convOf(s.path);
    assert.equal(after.length, before.length + 1);
    // 真实会话本来就可能有分支（编辑重发之类），所以比的是「没有新增断点」
    assert.deepEqual(breaksOf(after), beforeBreaks, '追加引入了新的链断点');
    assert.equal(after[after.length - 1].parentUuid, before[before.length - 1].uuid, '没接在原末尾');
  } finally {
    unwriteClaudeCodeSession({ targetId: s.sessionId, path: s.path }, { write: true });
  }
});

test('追加的记录带齐 sessionId / slug / entrypoint', async (t) => {
  const s = await makeSession(t);
  if (!s) return;
  try {
    const before = readJsonl(s.path);
    const sample = before.find((x) => x.type === 'user');
    appendClaudeCodeSession(s.sessionId, [{ role: 'user', text: '字段检查' }], { write: true });

    const added = readJsonl(s.path)
      .filter((x) => x.type === 'user' || x.type === 'assistant')
      .slice(-1)[0];
    assert.equal(added.sessionId, s.sessionId, 'sessionId 不对，resume 会读不到');
    assert.equal(added.slug, sample.slug, 'slug 该跟原会话一致');
    assert.equal(added.entrypoint, sample.entrypoint, 'entrypoint 该照抄，不能自己编');
    assert.ok(added.uuid && added.timestamp);
  } finally {
    unwriteClaudeCodeSession({ targetId: s.sessionId, path: s.path }, { write: true });
  }
});

test('找不到会话时不写任何东西', () => {
  const r = appendClaudeCodeSession('00000000-0000-0000-0000-000000000000', [
    { role: 'user', text: 'x' },
  ], { write: true });
  assert.equal(r.appended, 0);
  assert.match(String(r.reason), /找不到/);
});

test('空消息列表不产生任何写入', async (t) => {
  const s = await makeSession(t);
  if (!s) return;
  try {
    const before = fs.readFileSync(s.path);
    const r = appendClaudeCodeSession(s.sessionId, [], { write: true });
    assert.equal(r.appended, 0);
    assert.ok(fs.readFileSync(s.path).equals(before), '空列表不该动文件');
  } finally {
    unwriteClaudeCodeSession({ targetId: s.sessionId, path: s.path }, { write: true });
  }
});

test('同步关系和回流水位线读得出来', () => {
  const pairs = syncPairs();
  for (const p of pairs.slice(0, 20)) {
    assert.ok(p.sourceSession && p.tool && p.targetId, `关系缺字段：${JSON.stringify(p)}`);
    assert.ok(exists(p.path), 'syncPairs 该只返回文件还在的');
  }
  const marks = pullWatermarks();
  for (const [key, t] of marks) {
    assert.match(key, /^[a-z-]+:/, `水位线的 key 该是 tool:id，实际 ${key}`);
    assert.ok(Number.isFinite(t) && t > 0, '水位线该是有效时间戳');
  }
});

test('同步用全量、接力用摘要 —— 两种语义不能混', async (t) => {
  const { buildHandoff } = await import('../src/core/handoff.js');
  const { listSessions } = await import('../src/core/query.js');

  // 挑一条足够长的会话，短会话看不出差别
  const rows = await listSessions({ limit: 60 });
  const big = rows.find((r) => (r.messageCount || 0) > 40);
  if (!big) return t.skip('没有足够长的会话可对比');

  const brief = await buildHandoff(big.id);
  const full = await buildHandoff(big.id, { full: true });
  assert.ok(brief && full);

  // 接力：给对面 AI 的上下文，截到最后十几轮
  assert.ok(brief.turns.length <= 12, `接力模式该截断，实际 ${brief.turns.length} 轮`);
  // 同步：让会话出现在另一家列表里，点开该是完整历史
  assert.ok(
    full.turns.length > brief.turns.length,
    `full 模式没搬全：${full.turns.length} 轮 vs 接力的 ${brief.turns.length} 轮`,
  );
  assert.ok(
    full.turns.length >= Math.min(big.messageCount, 200),
    `full 模式该搬完整会话，源有 ${big.messageCount} 条，只搬了 ${full.turns.length} 条`,
  );
  // full 模式下单条也不该被截
  const cut = full.turns.filter((x) => String(x.text).includes('⟨本轮截断'));
  assert.equal(cut.length, 0, `full 模式下有 ${cut.length} 轮被截断了`);
});
