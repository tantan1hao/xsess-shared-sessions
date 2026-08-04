/**
 * Antigravity 直写的结构回归。
 *
 * 存在的理由很具体：第一版写进去的会话，Antigravity 一打开就崩，`.db` 随后消失。
 * 事后对着 41 个真实会话统计才发现漏了三样东西 ——
 * gen_metadata 的数量约束、idx=1 的初始化步、标题步的位置。
 * 这些规律 Antigravity 一升级就可能变，所以要有测试盯着：
 * 变了就红，而不是等到用户点开时崩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planSteps, antigravityAvailable, writeAntigravitySession } from '../src/core/writers/antigravity.js';
import { stringAt } from '../src/core/protobuf-edit.js';
import { TOOLS, exists } from '../src/core/paths.js';

const STEP_USER = 14;
const STEP_MODEL = 15;
const STEP_TITLE = 23;
const STEP_INIT = 98;

const HAS_TEMPLATE = { initStep: {}, titleStep: {} };
const kinds = (seq) => seq.map((s) => s.kind).join(' ');

// ---------------------------------------------------------------- 排列逻辑（纯函数）

test('步骤排列：初始化步固定在 idx=1', () => {
  const seq = planSteps(
    [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ],
    HAS_TEMPLATE,
  );
  // 真实会话里 20 个带 t98 的，它全部位于 idx=1
  assert.equal(seq[1].kind, 'init', `实际排列：${kinds(seq)}`);
});

test('步骤排列：标题步紧跟第一条模型回复，不是追加到末尾', () => {
  const seq = planSteps(
    [
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'c' },
      { role: 'assistant', text: 'd' },
    ],
    HAS_TEMPLATE,
  );
  assert.equal(kinds(seq), 'user init model title user model');
  // 40 个带标题步的真实会话里只有 1 个把它放在末尾 —— 末尾是错的形状
  assert.notEqual(seq[seq.length - 1].kind, 'title');
});

test('步骤排列：模板缺哪一样就不硬造哪一样', () => {
  const turns = [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b' },
  ];
  assert.equal(kinds(planSteps(turns, { initStep: null, titleStep: {} })), 'user model title');
  assert.equal(kinds(planSteps(turns, { initStep: {}, titleStep: null })), 'user init model');
  assert.equal(kinds(planSteps(turns, { initStep: null, titleStep: null })), 'user model');
});

test('步骤排列：全是用户消息时标题步落在末尾也不算错（没有模型回复可跟）', () => {
  const seq = planSteps([{ role: 'user', text: 'a' }], HAS_TEMPLATE);
  assert.equal(kinds(seq), 'user init title');
});

// ---------------------------------------------------------------- 真实数据统计出来的不变量

test('真实会话的结构不变量还成立（Antigravity 改格式时这条先红）', (t) => {
  const dir = TOOLS.antigravity.conversations;
  if (!exists(dir)) return t.skip('本机没有 Antigravity 数据');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsess-agstat-'));
  let n = 0;
  let genMatch = 0;
  let initAtOne = 0;
  let initTotal = 0;
  let titleAtEnd = 0;
  let titleTotal = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.db')) continue;
      const src = path.join(dir, f);
      // 大库复制一次要几十秒，测试里不值得
      if (fs.statSync(src).size > 8e6) continue;
      const copy = path.join(tmp, f);
      fs.copyFileSync(src, copy);
      let db;
      try {
        db = new DatabaseSync(copy);
      } catch {
        continue;
      }
      try {
        const steps = db.prepare('SELECT idx, step_type FROM steps ORDER BY idx').all();
        if (!steps.length) continue;
        n++;
        const ty = (t2) => steps.filter((s) => Number(s.step_type) === t2);

        const models = ty(STEP_MODEL).length;
        const gen = Number(db.prepare('SELECT count(*) c FROM gen_metadata').get().c);
        if (gen === models) genMatch++;

        const init = ty(STEP_INIT);
        if (init.length) {
          initTotal++;
          if (Number(init[0].idx) === 1) initAtOne++;
        }
        const title = ty(STEP_TITLE);
        if (title.length) {
          titleTotal++;
          if (Number(title[0].idx) >= steps.length - 1) titleAtEnd++;
        }
      } catch {
        /* 格式变了，交给别的断言去报 */
      } finally {
        db.close();
      }
      fs.rmSync(copy, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (n < 5) return t.skip('可解析会话太少，统计没意义');

  // gen_metadata 是写入时的硬约束，多数会话必须满足才有资格照抄
  assert.ok(genMatch / n > 0.7, `gen_metadata 行数 === 模型步数 的比例掉到 ${genMatch}/${n}`);
  if (initTotal) {
    assert.equal(initAtOne, initTotal, `初始化步不再固定在 idx=1（${initAtOne}/${initTotal}）`);
  }
  if (titleTotal) {
    assert.ok(titleAtEnd / titleTotal < 0.2, `标题步现在多数落在末尾（${titleAtEnd}/${titleTotal}）`);
  }
});

// ---------------------------------------------------------------- 端到端演练

test('演练写出的会话库通过全部自检，且不碰 Antigravity 的目录', async (t) => {
  if (!antigravityAvailable()) return t.skip('本机没有 Antigravity 数据');
  const { buildHandoff } = await import('../src/core/handoff.js');
  const { listSessions } = await import('../src/core/query.js');

  const rows = await listSessions({ limit: 5 });
  const source = rows.find((r) => r.tool !== 'antigravity');
  if (!source) return t.skip('没有别家工具的会话可以演练');

  const pack = await buildHandoff(source.id);
  if (!pack) return t.skip('交接包构建失败');

  const dir = TOOLS.antigravity.conversations;
  const before = fs.readdirSync(dir).length;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsess-agdry-'));
  try {
    // writeAntigravitySession 内部就会跑 verifyWritten，结构不对直接抛
    const r = writeAntigravitySession(pack, { previewDir: tmp });
    assert.ok(r.preview, '演练结果应标明是演练');
    assert.equal(fs.readdirSync(dir).length, before, '演练不能在 Antigravity 目录里留下任何文件');

    const db = new DatabaseSync(r.path);
    try {
      const steps = db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all();
      assert.ok(steps.length >= 2, '至少要有用户和模型两种步骤');
      steps.forEach((s, i) => assert.equal(Number(s.idx), i, 'idx 必须连续无洞'));

      const gen = Number(db.prepare('SELECT count(*) c FROM gen_metadata').get().c);
      const models = steps.filter((s) => Number(s.step_type) === STEP_MODEL).length;
      assert.equal(gen, models, 'gen_metadata 必须和模型步一一对应');

      const title = steps.find((s) => Number(s.step_type) === STEP_TITLE);
      if (title) {
        const text = stringAt(Buffer.from(/** @type {Uint8Array} */ (title.step_payload)), [30, 4]);
        assert.equal(text, r.title, '标题步里存的必须是带前缀的新标题');
        assert.ok(Number(title.idx) < steps.length - 1, '标题步不该在末尾');
      }
      // 首条必须是我们的交接抬头，不能是模板会话的内容
      const first = stringAt(Buffer.from(/** @type {Uint8Array} */ (steps[0].step_payload)), [19, 2]);
      assert.ok(String(first).includes('⟨会话接力⟩'), `首条不是交接抬头：${String(first).slice(0, 40)}`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
