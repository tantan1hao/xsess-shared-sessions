/**
 * 适配器的真实数据回归测试。
 *
 * 这些断言对着本机真实的会话文件跑 —— 目的就是「Antigravity 或 Cursor 升级
 * 改了存储格式时，测试先红」，而不是索引静默变空、几周后才发现。
 *
 * 数据不在（换台机器、或该工具没装）就跳过，不让测试假失败。
 *
 * 涉及具体会话内容的断言从 `tests/fixtures.local.json` 读 —— 那是私人对话，
 * 不进仓库。没有这个文件时相关测试自动跳过，模板见 `fixtures.local.example.json`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapter as antigravity } from '../src/core/adapters/antigravity.js';
import { adapter as cursor } from '../src/core/adapters/cursor.js';
import { adapter as claudeCode } from '../src/core/adapters/claude-code.js';
import { adapter as codex } from '../src/core/adapters/codex.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 本机的 ground truth。没配就返回 null，调用方负责跳过。 */
function localFixture(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures.local.json'), 'utf8'));
    const f = raw[key];
    // 模板里的占位文本要当成「没配」，否则会拿提示语去断言
    if (!f || !f.id || f.id.includes('把') || f.id.includes('填')) return null;
    return f;
  } catch {
    return null;
  }
}

const SKIP_HINT = '没配 tests/fixtures.local.json（见 fixtures.local.example.json）';

test('Antigravity: protobuf 解析出正确的首条用户消息和标题', async (t) => {
  if (!antigravity.available()) return t.skip('本机没有 Antigravity 数据');
  const fx = localFixture('antigravity');
  if (!fx) return t.skip(SKIP_HINT);

  const sources = await antigravity.discover();
  const src = sources.find((s) => s.path.includes(fx.id));
  if (!src) return t.skip(`本机没有 ${fx.id} 这个会话`);

  const [session] = await antigravity.parse(src);
  assert.equal(session.tool, 'antigravity');
  if (fx.title) {
    assert.equal(session.title, fx.title, '标题应来自 step_type=23 的 30.4 字段');
  }

  const firstUser = session.messages.find((m) => m.role === 'user');
  assert.ok(firstUser, '应该解出至少一条用户消息');
  assert.equal(
    firstUser.text,
    fx.firstUserMessage,
    '正文里不该混进 protobuf 帧字节或 mcp(...) 权限串',
  );

  assert.ok(
    session.messages.some((m) => m.role === 'assistant' && m.text.length > 100),
    '应该解出 AI 的散文回复（20.1 字段）',
  );
});

test('Antigravity: 所有会话都能解析且不产生纯噪音标题', async (t) => {
  if (!antigravity.available()) return t.skip('本机没有 Antigravity 数据');
  const sources = await antigravity.discover();
  if (!sources.length) return t.skip('没有会话文件');

  let withMessages = 0;
  let parsed = 0;
  for (const src of sources) {
    // Antigravity 会为「索引里挂着、文件却没了」的条目造空库，
    // 适配器跳过它们并返回空数组 —— 那不是解析失败
    const [s] = await antigravity.parse(src);
    if (!s) continue;
    parsed++;
    assert.ok(s.id.startsWith('antigravity:'));
    assert.doesNotMatch(
      s.title,
      /^[0-9a-f]{8}-[0-9a-f]{4}-/,
      `标题不该是裸 UUID：${s.title}（${src.path}）`,
    );
    if (s.messageCount > 0) withMessages++;
  }
  assert.ok(parsed > 0, '一个会话都没解析出来');
  assert.ok(
    withMessages / parsed > 0.5,
    `超过一半的会话应该有内容，实际 ${withMessages}/${parsed} —— 低于这个值多半是格式变了`,
  );
});

test('Cursor: 新旧两种消息索引格式都能读', async (t) => {
  if (!cursor.available()) return t.skip('本机没有 Cursor 数据');
  const sources = await cursor.discover();
  if (!sources.length) return t.skip('没有 composer');

  let totalMessages = 0;
  for (const src of sources) {
    const [s] = await cursor.parse(src);
    if (!s) continue;
    totalMessages += s.messageCount;
  }
  assert.ok(totalMessages > 0, 'Cursor 会话应该解出消息，一条都没有说明 bubbleId 键名变了');
});

test('Cursor: 增量水位线用会话自己的 lastUpdatedAt，不是整库 mtime', async (t) => {
  if (!cursor.available()) return t.skip('本机没有 Cursor 数据');
  const sources = await cursor.discover();
  if (sources.length < 2) return t.skip('会话太少，看不出差异');
  const mtimes = new Set(sources.map((s) => s.mtimeMs));
  assert.ok(
    mtimes.size > 1,
    '每个 composer 该有各自的水位线，全都一样说明退化成了整库 mtime，一改全量重解',
  );
});

test('Claude Code: tool_result 不该被当成用户消息', async (t) => {
  if (!claudeCode.available()) return t.skip('本机没有 Claude Code 数据');
  const sources = await claudeCode.discover();
  if (!sources.length) return t.skip('没有会话文件');

  const biggest = sources.sort((a, b) => b.size - a.size)[0];
  const [s] = await claudeCode.parse(biggest);
  const roles = new Set(s.messages.map((m) => m.role));
  assert.ok(roles.has('user') && roles.has('assistant'), '应该同时有用户和 AI 消息');
  // type:"user" 里装 tool_result 的记录必须归到 tool，否则标题和轮次统计全错
  assert.ok(roles.has('tool'), '带工具调用的会话应该解出 tool 角色的消息');
});

test('Codex: 子代理会话被正确标记（否则会淹没会话栏）', async (t) => {
  if (!codex.available()) return t.skip('本机没有 Codex 数据');
  const sources = await codex.discover();
  if (sources.length < 10) return t.skip('会话太少，统计没意义');

  let subagents = 0;
  for (const src of sources.slice(0, 60)) {
    const [s] = await codex.parse(src);
    if (s.isSubagent) subagents++;
  }
  assert.ok(subagents > 0, '应该识别出 thread_source=subagent 的会话');
});

test('每个适配器的 discover 都返回结构完整的 SourceRef', async () => {
  for (const a of [claudeCode, codex, antigravity, cursor]) {
    if (!a.available()) continue;
    const sources = await a.discover();
    for (const s of sources.slice(0, 5)) {
      assert.equal(typeof s.sourceId, 'string', `${a.tool} 缺 sourceId`);
      assert.equal(typeof s.path, 'string', `${a.tool} 缺 path`);
      assert.equal(typeof s.mtimeMs, 'number', `${a.tool} 的 mtimeMs 必须是数字`);
      assert.equal(typeof s.size, 'number', `${a.tool} 的 size 必须是数字`);
      assert.ok(s.sourceId.startsWith(a.tool + ':'), `${a.tool} 的 sourceId 应带工具前缀`);
    }
  }
});
