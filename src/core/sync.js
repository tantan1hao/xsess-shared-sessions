/**
 * 同步管理 —— 决定哪些别家工具的会话出现在目标工具**原生的**会话栏里。
 *
 * 定位：Web 面板负责「开关和挑选」，真正的展示还是在各家 IDE 自己的会话列表里。
 * 所以这一层要回答三个问题：
 *   1. 哪些会话已经同步过去了（避免重复写）
 *   2. 批量同步一批过去
 *   3. 取消同步（撤回）
 *
 * 这里只做调度，不碰任何一家的存储细节 —— 各家要写什么、要清什么，
 * 都在 writers/ 里各自实现（差别很大：Claude Code 只有一个文件，
 * Codex 有三层索引，Antigravity 要重拼它的会话列表）。
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildHandoff } from './handoff.js';
import { writeSession, unwriteSession, TIER_A } from './writers/index.js';
import { listWrites } from './writers/manifest.js';
import { exists } from './paths.js';

/**
 * xsess 往目标工具写过、且还没撤销的所有会话。
 *
 * 关键点：**不要求会话文件还在**。实测过一次，写进去的会话被目标应用清掉了，
 * 索引记录却留着 —— 这种孤儿会一直挂在人家的会话列表里、点开是空的。
 * 只看「文件还在」的话它永远清不掉，所以这里要连孤儿一起收。
 *
 * @param {string} targetTool
 * @returns {Map<string, {sourceSession:string, path:string|null, createdAt:string, orphan:boolean}>}
 *   目标会话 ID → 信息
 */
export function writtenSessions(targetTool) {
  const map = new Map();
  for (const e of listWrites()) {
    if (e.tool !== targetTool) continue;
    const id = e.targetId || e.appendedId || idFromPath(e.path);
    if (!id) continue;

    if (e.kind === 'unsync') {
      map.delete(id);
      continue;
    }
    if (e.kind) {
      // 索引类记录（append / index / name）。会话文件那条记录才带路径，
      // 这里只在它还没出现时占位 —— 孤儿就是只有这类记录的情况
      if (!map.has(id)) {
        map.set(id, { sourceSession: e.sourceSession, path: null, createdAt: e.createdAt });
      }
      continue;
    }
    map.set(id, { sourceSession: e.sourceSession, path: e.path, createdAt: e.createdAt });
  }
  for (const v of map.values()) v.orphan = !v.path || !exists(v.path);
  return map;
}

/**
 * 旧清单记录没有 targetId，只能从文件名反推。
 * 新写入的都带 targetId，这里纯粹是为了不丢历史记录。
 */
function idFromPath(p) {
  if (!p) return null;
  const base = path.basename(String(p));
  // Codex: rollout-2026-08-04T11-46-05-<uuid>.jsonl
  const rollout = /^rollout-.*?-([0-9a-f-]{36})\.jsonl$/i.exec(base);
  if (rollout) return rollout[1];
  // Claude Code / Antigravity: <uuid>.jsonl | <uuid>.db
  const plain = /^([0-9a-f-]{36})\.(db|jsonl)$/i.exec(base);
  return plain ? plain[1] : null;
}

/**
 * 已同步的会话：源会话 ID → 目标信息。
 * 孤儿不算「已同步」—— 用户看到的是个点不开的空条目，重新同步一次才对。
 */
export function syncedMap(targetTool = 'antigravity') {
  const map = new Map();
  for (const [targetId, v] of writtenSessions(targetTool)) {
    if (v.orphan || !v.sourceSession) continue;
    map.set(v.sourceSession, { path: v.path, createdAt: v.createdAt, targetId });
  }
  return map;
}

/**
 * 目标应用是否在运行。
 *
 * 只有 Antigravity 需要拦：它把会话列表整个缓存在内存里，退出时会覆盖掉我们写的。
 * Codex 不用 —— 它的 threads 表是 SQLite（WAL 支持并发写），
 * 实测 ChatGPT.app 开着也能正常写入，只是侧边栏要重启才刷新。
 */
export function targetRunning(tool) {
  const pat = {
    antigravity: 'Antigravity.app/Contents/MacOS/Antigravity',
    'claude-code': null,
    codex: null,
  }[tool];
  if (!pat) return false;
  try {
    return new RegExp(pat.replace(/[.]/g, '\\.')).test(
      execFileSync('/bin/ps', ['-eo', 'comm'], { encoding: 'utf8' }),
    );
  } catch {
    return false;
  }
}

/** 写完之后用户还要做什么才能看到 */
export function afterSyncHint(tool) {
  if (tool === 'codex') return '打开 codex resume 就能看到；ChatGPT.app 的侧边栏需要重启后刷新。';
  if (tool === 'antigravity') return '打开 Antigravity，在 Conversation History 里就能看到。';
  if (tool === 'claude-code') return '终端跑 claude --resume 就能看到。';
  return '';
}

/**
 * 批量同步。
 * @param {string[]} ids 源会话 ID
 * @param {{to?:string, write?:boolean, allowWhileRunning?:boolean}} [opts]
 */
export async function syncMany(ids, opts = {}) {
  const { to = 'antigravity', write = false, allowWhileRunning = false } = opts;
  if (!TIER_A.includes(to)) throw new Error(`不支持同步到 ${to}（支持：${TIER_A.join(', ')}）`);

  if (write && !allowWhileRunning && targetRunning(to)) {
    throw new Error(
      `${to} 正在运行。它把会话列表缓存在内存里，退出时会覆盖掉我们写入的内容 —— 先完全退出再同步。`,
    );
  }

  const already = syncedMap(to);
  const results = { target: to, synced: [], skipped: [], failed: [] };

  for (const id of ids) {
    if (already.has(id)) {
      results.skipped.push({ id, reason: '已经同步过' });
      continue;
    }
    try {
      const pack = await buildHandoff(id);
      if (!pack) {
        results.failed.push({ id, error: '找不到该会话' });
        continue;
      }
      const r = await writeSession(to, pack, { write, allowWhileRunning });
      results.synced.push({ id, title: r.title, path: r.path, targetId: r.sessionId });
      // 预览模式下也要防止同一批里重复挑同一条
      already.set(id, { path: r.path, targetId: r.sessionId, createdAt: '' });
    } catch (e) {
      results.failed.push({ id, error: e.message });
    }
  }
  return results;
}

/**
 * 取消同步。具体要清哪些东西交给各家的 writer —— 见 writers/index.js 的 UNWRITERS。
 *
 * @param {string[]|null} sourceIds 要撤的源会话 ID；null = 全部
 * @param {{to?:string, write?:boolean, allowWhileRunning?:boolean, orphansOnly?:boolean}} [opts]
 *   orphansOnly：只清残骸（索引里挂着、会话文件已不在的）。
 *   同一个源会话可能既有正常同步的、又有早先留下的残骸，
 *   按源 ID 撤会把正常那条一起带走 —— 想单独清残骸就用这个。
 */
export async function unsync(
  sourceIds,
  { to = 'antigravity', write = false, allowWhileRunning = false, orphansOnly = false } = {},
) {
  const written = writtenSessions(to);
  const targets = [...written.entries()].filter(([, v]) => {
    if (orphansOnly && !v.orphan) return false;
    return !sourceIds || (v.sourceSession && sourceIds.includes(v.sourceSession));
  });

  const result = { target: to, removed: [], orphans: 0, keptRecords: 0, droppedRecords: 0 };
  if (!targets.length) return result;
  result.orphans = targets.filter(([, v]) => v.orphan).length;

  if (write && !allowWhileRunning && targetRunning(to)) {
    throw new Error(`${to} 正在运行，先完全退出再撤销。`);
  }

  for (const [targetId, info] of targets) {
    const r = await unwriteSession(to, { targetId, path: info.path }, { write, allowWhileRunning });
    result.removed.push({
      sourceSession: info.sourceSession,
      path: info.path,
      targetId,
      orphan: info.orphan,
      cleaned: r.removed || [],
    });
    // Antigravity 会报它的会话列表剩多少条，其它工具没有这个概念
    if (Number.isInteger(r.keptRecords)) result.keptRecords = r.keptRecords;
    if (Number.isInteger(r.droppedRecords)) result.droppedRecords += r.droppedRecords;
    // 撤销记录由 writer 自己记（谁执行删除谁记账），这里不重复记
  }
  return result;
}

/** 面板要展示的整体状态 */
export async function syncStatus({ to = 'antigravity' } = {}) {
  const synced = syncedMap(to);
  // 孤儿会让目标的会话列表里挂着点不开的条目，面板要能提示用户清掉
  const orphans = [...writtenSessions(to).entries()]
    .filter(([, v]) => v.orphan)
    .map(([targetId, v]) => ({ targetId, sourceSession: v.sourceSession }));
  return {
    target: to,
    targets: TIER_A,
    running: targetRunning(to),
    hint: afterSyncHint(to),
    syncedCount: synced.size,
    synced: [...synced.entries()].map(([sourceSession, v]) => ({ sourceSession, ...v })),
    orphanCount: orphans.length,
    orphans,
  };
}
