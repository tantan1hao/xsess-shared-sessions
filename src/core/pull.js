/**
 * 回流 —— 把接力过去之后、在**目标那边**产生的新对话拉回源会话。
 *
 * ── 为什么需要 ──
 * `sync` / `handoff` 是单向快照：把 A 的会话复制一份到 B。
 * 你在 B 里接着干活，那部分永远回不到 A —— 回到 A 一看还停在接力那一刻。
 * 这不是「互通」，只是「搬运」。
 *
 * ── 怎么认出「新增的部分」──
 * 按时间戳切。xsess 写入时，整份会话的时间戳都落在写入那一瞬间
 * （毫秒级连号），之后你在目标工具里聊的每一句必然更晚。
 * 所以「同步时刻 + 一分钟宽限」之后的消息，就是那边新长出来的。
 *
 * 实测这个判据很准：一条 8/4 03:46 接力过去的会话，21:31 在 Codex 里
 * 聊了两句，切出来正好是那两句，一条不多一条不少。
 *
 * ── 安全边界 ──
 * 回流是**追加**：在源会话文件尾部接上新记录，已有字节一个都不改。
 * 和 Antigravity 索引追加、Codex 写回同级。写前照例备份。
 */

import { listWrites, recordWrite } from './writers/manifest.js';
import { getSession } from './query.js';
import { exists } from './paths.js';
import path from 'node:path';

/**
 * 宽限期。xsess 写一份会话的耗时在毫秒级，但目标工具可能稍后才落盘，
 * 留一分钟避免把「刚写进去的那份」误判成新增。
 */
const GRACE_MS = 60_000;

/**
 * 所有还有效的同步关系。
 * @returns {{sourceSession:string, tool:string, targetId:string, path:string, syncedAt:string}[]}
 */
export function syncPairs() {
  const undone = new Set();
  const pairs = new Map();
  for (const e of listWrites()) {
    const id = e.targetId || e.appendedId || idFromPath(e.path);
    if (!id) continue;
    if (e.kind === 'unsync') {
      undone.add(id);
      pairs.delete(id);
      continue;
    }
    if (e.kind) continue; // 索引类记录，不是会话文件
    if (!e.sourceSession) continue;
    pairs.set(id, {
      sourceSession: e.sourceSession,
      tool: e.tool,
      targetId: id,
      path: e.path,
      syncedAt: e.createdAt,
    });
  }
  return [...pairs.values()].filter((p) => !undone.has(p.targetId) && exists(p.path));
}

/**
 * 每对同步关系上次回流到什么时刻。
 *
 * 没有这个水位线，回流就是不幂等的：源会话被追加了内容，但**目标那边的
 * 时间戳没变**，下次再跑还会检测到同一批消息，再追加一遍。
 * 所以每次回流都记一笔，下次从这个时刻往后看。
 *
 * @returns {Map<string, number>} 目标会话 key → 上次回流的毫秒时间戳
 */
export function pullWatermarks() {
  const map = new Map();
  for (const e of listWrites()) {
    if (e.kind !== 'pull' || !e.pulledFrom) continue;
    const t = new Date(e.createdAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (t > (map.get(e.pulledFrom) || 0)) map.set(e.pulledFrom, t);
  }
  return map;
}

/** 记一次回流，供下次算水位线 */
export function recordPull(targetKey, sourceSession) {
  recordWrite({
    tool: 'xsess',
    kind: 'pull',
    path: '',
    pulledFrom: targetKey,
    sourceSession,
  });
}

/** 老清单记录没有 targetId，只能从文件名反推 */
function idFromPath(p) {
  if (!p) return null;
  const base = path.basename(String(p));
  const rollout = /^rollout-.*?-([0-9a-f-]{36})\.jsonl$/i.exec(base);
  if (rollout) return rollout[1];
  const plain = /^([0-9a-f-]{36})\.(db|jsonl)$/i.exec(base);
  return plain ? plain[1] : null;
}

/**
 * 找出「目标那边有新进展、源会话还不知道」的同步关系。
 *
 * @param {{sourceTool?:string, targetTool?:string}} [opts]
 * @returns {Promise<{pair:any, fresh:{role:string,text:string,ts?:string}[],
 *   sourceTitle:string, targetTitle:string, sourceExists:boolean}[]>}
 */
export async function findDrift(opts = {}) {
  const { sourceTool, targetTool } = opts;
  const marks = pullWatermarks();
  const out = [];

  for (const pair of syncPairs()) {
    if (targetTool && pair.tool !== targetTool) continue;
    if (sourceTool && !String(pair.sourceSession).startsWith(sourceTool + ':')) continue;

    const targetKey = `${pair.tool}:${pair.targetId}`;
    const target = await getSession(targetKey, { maxMessages: 2000 });
    if (!target) continue;

    // 从「接力时刻」和「上次回流时刻」里取晚的那个 —— 回流过的不再重复拉
    const cutoff = Math.max(
      new Date(pair.syncedAt).getTime() + GRACE_MS,
      marks.get(targetKey) || 0,
    );
    const fresh = target.messages.filter((m) => {
      if (!m.ts) return false;
      const t = new Date(m.ts).getTime();
      return Number.isFinite(t) && t > cutoff;
    });
    if (!fresh.length) continue;

    const source = await getSession(pair.sourceSession, { maxMessages: 1 });
    out.push({
      pair,
      fresh,
      sourceTitle: source ? source.title : '(源会话已不在)',
      targetTitle: target.title,
      sourceExists: !!source,
    });
  }
  // 新增多的排前面 —— 那些最值得先看
  return out.sort((a, b) => b.fresh.length - a.fresh.length);
}
