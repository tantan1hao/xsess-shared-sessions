/**
 * Claude Code 写回的回归测试。
 *
 * 这家没有额外的索引层（`claude --resume` 直接扫 ~/.claude/projects/），
 * 所以文件结构就是全部 —— 少写一个字段就是少一个功能。
 * 下面每条断言都对着真实会话文件比对过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, exists } from '../src/core/paths.js';

const PROJECTS = TOOLS['claude-code'].projects;

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

/** 写一条出来（不落盘到真实目录之外的地方，用完就撤） */
async function writeOne(t) {
  if (!exists(PROJECTS)) return t.skip('本机没有 Claude Code 数据');
  const { buildHandoff } = await import('../src/core/handoff.js');
  const { listSessions } = await import('../src/core/query.js');

  // 按工具逐个找，不靠混排列表的排序 ——
  // 往 Claude Code 里整批同步过之后，列表前几十条全是它自己的，
  // 用 find(tool !== 'claude-code') 会一条都挑不到，测试就静默跳过了
  let source = null;
  for (const tool of ['codex', 'antigravity', 'cursor', 'gemini-cli']) {
    const rows = await listSessions({ tool, limit: 5 });
    source = rows.find((r) => (r.messageCount || 0) >= 2);
    if (source) break;
  }
  if (!source) return t.skip('没有别家工具的会话可用');
  const pack = await buildHandoff(source.id);
  if (!pack) return t.skip('交接包构建失败');

  const { writeClaudeCodeSession } = await import('../src/core/writers/claude-code.js');
  return { pack, source, write: () => writeClaudeCodeSession(pack, { write: true }) };
}

test('标题写进 custom-title —— 会话列表显示的是它，不是 ai-title', async (t) => {
  const ctx = await writeOne(t);
  if (!ctx) return;
  const { unwriteClaudeCodeSession } = await import('../src/core/writers/claude-code.js');

  const r = ctx.write();
  try {
    const rows = readJsonl(r.path);
    const ai = rows.find((x) => x.type === 'ai-title');
    const custom = rows.find((x) => x.type === 'custom-title');

    assert.ok(custom, 'custom-title 没写 —— 列表里显示不出我们加的来源前缀');
    assert.equal(custom.customTitle, r.title);
    assert.ok(ai, 'ai-title 也该写');
    assert.equal(ai.aiTitle, r.title);
    // 前缀标的是来源工具，不是 claude-code 自己
    assert.match(r.title, /^\w{2}：/, `标题该带来源前缀，实际 ${r.title}`);
  } finally {
    unwriteClaudeCodeSession({ targetId: r.sessionId, path: r.path }, { write: true });
  }
});

test('slug 全会话统一且非空', async (t) => {
  const ctx = await writeOne(t);
  if (!ctx) return;
  const { unwriteClaudeCodeSession } = await import('../src/core/writers/claude-code.js');

  const r = ctx.write();
  try {
    const rows = readJsonl(r.path);
    const conv = rows.filter((x) => x.type === 'user' || x.type === 'assistant');
    const slugs = [...new Set(conv.map((x) => x.slug))];
    assert.equal(slugs.length, 1, `slug 不统一：${JSON.stringify(slugs)}`);
    assert.ok(slugs[0], 'slug 是空的');
    // 真实会话的 slug 是 URL 友好的：小写字母数字和连字符
    assert.match(String(slugs[0]), /^[a-z0-9-]+$/, `slug 形状不对：${slugs[0]}`);
    assert.ok(!String(slugs[0]).endsWith('-'), 'slug 结尾不该是连字符');
  } finally {
    unwriteClaudeCodeSession({ targetId: r.sessionId, path: r.path }, { write: true });
  }
});

test('entrypoint / version 用本机真实取值，不能自己编', async (t) => {
  const ctx = await writeOne(t);
  if (!ctx) return;
  const { unwriteClaudeCodeSession } = await import('../src/core/writers/claude-code.js');

  // 本机真实会话用的 entrypoint（跳过 xsess 自己写的，否则是自己验自己）
  const { listWrites } = await import('../src/core/writers/manifest.js');
  const ours = new Set(listWrites().filter((e) => e.tool === 'claude-code').map((e) => path.basename(String(e.path))));
  const real = new Set();
  for (const d of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, d);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || ours.has(f)) continue;
      for (const row of readJsonl(path.join(dir, f)).slice(0, 5)) {
        if (row.entrypoint) real.add(row.entrypoint);
      }
    }
  }
  if (!real.size) return t.skip('没有真实会话可对照');

  const r = ctx.write();
  try {
    const rows = readJsonl(r.path);
    const conv = rows.filter((x) => x.type === 'user' || x.type === 'assistant');
    for (const rec of conv) {
      // 自己编一个值的后果：桌面版侧边栏把这条会话过滤掉，
      // 文件写得再对也看不见（Codex 那边的 source 是一模一样的坑）
      assert.ok(
        real.has(rec.entrypoint),
        `entrypoint=${JSON.stringify(rec.entrypoint)} 不在本机真实取值里（${[...real].join(', ')}）`,
      );
      assert.match(String(rec.version), /^\d+\.\d+\.\d+/, `version 形状不对：${rec.version}`);
      // 空字符串是「明确声明没有分支」，跟「不知道」不是一回事
      assert.notEqual(rec.gitBranch, '', 'gitBranch 不该写空字符串，没有就省略');
    }
  } finally {
    unwriteClaudeCodeSession({ targetId: r.sessionId, path: r.path }, { write: true });
  }
});

test('写进去的会话登记进了桌面版侧边栏的索引', async (t) => {
  const { desktopIndexAvailable, activeSessionGroup } = await import(
    '../src/core/writers/claude-desktop-index.js'
  );
  if (!desktopIndexAvailable()) return t.skip('本机没有 Claude 桌面版');
  const ctx = await writeOne(t);
  if (!ctx) return;
  const { unwriteClaudeCodeSession } = await import('../src/core/writers/claude-code.js');

  const group = activeSessionGroup();
  assert.ok(group, '找不到桌面版当前在用的会话组');
  const countJson = () => fs.readdirSync(group.dir).filter((f) => f.endsWith('.json')).length;
  const before = countJson();

  const r = ctx.write();
  try {
    // 光写 ~/.claude/projects 是不够的：桌面版侧边栏读的是它自己那个目录
    assert.equal(countJson(), before + 1, '桌面版索引里没多出记录 —— 侧边栏看不到这条会话');

    const rec = fs
      .readdirSync(group.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(group.dir, f), 'utf8')))
      .find((x) => x.cliSessionId === r.sessionId);
    assert.ok(rec, '索引里找不到 cliSessionId 对应的记录');
    assert.equal(rec.title, r.title);
    assert.equal(rec.isArchived, false, '归档的不会出现在侧边栏');
    assert.match(String(rec.sessionId), /^local_/, 'sessionId 要用 local_ 前缀');
    // model / permissionMode 是桌面版自己的运行配置，必须照抄同组真实记录
    assert.equal(rec.model, group.sample.model);
    assert.equal(rec.permissionMode, group.sample.permissionMode);
  } finally {
    unwriteClaudeCodeSession({ targetId: r.sessionId, path: r.path }, { write: true });
  }
  assert.equal(countJson(), before, '撤销后桌面版索引没回到原样');
});

test('parentUuid 把对话串成一条完整的链', async (t) => {
  const ctx = await writeOne(t);
  if (!ctx) return;
  const { unwriteClaudeCodeSession } = await import('../src/core/writers/claude-code.js');

  const r = ctx.write();
  try {
    const conv = readJsonl(r.path).filter((x) => x.type === 'user' || x.type === 'assistant');
    assert.ok(conv.length >= 2, '至少要有一问一答');
    let prev = null;
    conv.forEach((rec, i) => {
      assert.equal(rec.parentUuid, prev, `第 ${i} 条的 parentUuid 断了 —— resume 会读不全上下文`);
      prev = rec.uuid;
    });
    // sessionId 必须和文件名一致，否则 resume 找不到
    assert.equal(path.basename(r.path, '.jsonl'), r.sessionId);
    for (const rec of conv) assert.equal(rec.sessionId, r.sessionId);
  } finally {
    unwriteClaudeCodeSession({ targetId: r.sessionId, path: r.path }, { write: true });
  }
});

test('写完再撤销，目录回到原样', async (t) => {
  const ctx = await writeOne(t);
  if (!ctx) return;
  const { unwriteClaudeCodeSession } = await import('../src/core/writers/claude-code.js');

  const r = ctx.write();
  const parent = path.dirname(r.path);
  const before = fs.readdirSync(parent).length;
  assert.ok(exists(r.path), '文件没写出来');

  unwriteClaudeCodeSession({ targetId: r.sessionId, path: r.path }, { write: true });
  assert.ok(!exists(r.path), '撤销后文件还在');
  assert.equal(fs.readdirSync(parent).length, before - 1, '撤销后目录没回到原样');
});
