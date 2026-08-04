/**
 * 同步管理 —— 决定哪些别家工具的会话出现在 Antigravity 原生的会话栏里。
 *
 * 定位：Web 面板负责「开关和挑选」，真正的展示还是在各家 IDE 自己的会话列表里。
 * 所以这一层要回答三个问题：
 *   1. 哪些会话已经同步过去了（避免重复写）
 *   2. 批量同步一批过去
 *   3. 取消同步（撤回）
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getSession } from './query.js';
import { buildHandoff } from './handoff.js';
import { writeSession, TIER_A } from './writers/index.js';
import { listWrites, recordWrite } from './writers/manifest.js';
import { TOOLS, BACKUP_DIR, ensureXsessDirs, exists } from './paths.js';
import { splitFields, stringAt, lenDelim } from './protobuf-edit.js';

const AG_ROOT = path.dirname(TOOLS.antigravity.conversations);
const SUMMARIES = path.join(AG_ROOT, 'agyhub_summaries_proto.pb');

/**
 * 已同步的会话：源会话 ID → 目标信息。
 * 只认清单里记过、且目标文件确实还在的 —— 用户手动删掉之后就不该再算「已同步」。
 */
export function syncedMap(targetTool = 'antigravity') {
  const map = new Map();
  for (const e of listWrites()) {
    if (e.tool !== targetTool || !e.sourceSession) continue;
    if (e.kind === 'append') continue; // 索引追加记录，不是会话文件本身
    if (!exists(e.path)) continue;
    map.set(e.sourceSession, { path: e.path, createdAt: e.createdAt, targetId: path.basename(e.path, '.db') });
  }
  return map;
}

/** 目标应用是否在运行 —— 在跑的时候写入会被它退出时的缓存覆盖 */
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
  const results = { synced: [], skipped: [], failed: [] };

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
      already.set(id, { path: r.path });
    } catch (e) {
      results.failed.push({ id, error: e.message });
    }
  }
  return results;
}

/**
 * 取消同步：删掉写进去的会话文件，并把索引里对应的记录摘掉。
 *
 * 摘记录需要重写整个 `agyhub_summaries_proto.pb`（追加能只加不改，删就不行了）。
 * 但顶层是纯 repeated 字段，每条记录彼此独立，所以「删一条」在字节层面就是
 * 把剩下的记录按原样重新拼起来 —— 不解析记录内部，也就不会改坏它们。
 * 写之前照例备份 + 自检。
 *
 * @param {string[]|null} sourceIds 要撤的源会话 ID；null = 全部
 */
export async function unsync(sourceIds, { to = 'antigravity', write = false, allowWhileRunning = false } = {}) {
  const synced = syncedMap(to);
  const targets = [...synced.entries()].filter(([src]) => !sourceIds || sourceIds.includes(src));

  const result = { removed: [], keptRecords: 0, droppedRecords: 0 };
  if (!targets.length) return result;

  if (write && !allowWhileRunning && targetRunning(to)) {
    throw new Error(`${to} 正在运行，先完全退出再撤销。`);
  }

  const targetIds = new Set(targets.map(([, v]) => v.targetId));

  if (to === 'antigravity' && exists(SUMMARIES)) {
    const file = fs.readFileSync(SUMMARIES);
    const kept = [];
    let dropped = 0;
    for (const f of splitFields(file)) {
      if (f.field !== 1) continue;
      const body = file.subarray(f.valueStart, f.valueEnd);
      const id = stringAt(body, [1]);
      if (id && targetIds.has(id)) {
        dropped++;
        continue;
      }
      kept.push(body);
    }
    result.keptRecords = kept.length;
    result.droppedRecords = dropped;

    if (write && dropped) {
      backupSummaries();
      const next = Buffer.concat(kept.map((b) => lenDelim(1, b)));
      // 自检：重拼出来的文件必须能完整解析，且记录数对得上
      const check = splitFields(next).filter((x) => x.field === 1);
      const covered = check.length ? check[check.length - 1].valueEnd : 0;
      if (check.length !== kept.length || covered !== next.length) {
        throw new Error('重拼的索引文件自检没过，已放弃写入（原文件未动）');
      }
      writeAtomic(SUMMARIES, next);
    }
  }

  for (const [src, info] of targets) {
    result.removed.push({ sourceSession: src, path: info.path, targetId: info.targetId });
    if (write) {
      for (const ext of ['', '-wal', '-shm']) {
        try {
          fs.rmSync(info.path + ext, { force: true });
        } catch {
          /* 忽略 */
        }
      }
      recordWrite({ tool: to, path: info.path, kind: 'unsync', sourceSession: src });
    }
  }
  return result;
}

/** 面板要展示的整体状态 */
export async function syncStatus({ to = 'antigravity' } = {}) {
  const synced = syncedMap(to);
  return {
    target: to,
    running: targetRunning(to),
    syncedCount: synced.size,
    synced: [...synced.entries()].map(([sourceSession, v]) => ({ sourceSession, ...v })),
  };
}

function backupSummaries() {
  ensureXsessDirs();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SUMMARIES, path.join(BACKUP_DIR, `agyhub_summaries_proto.pb.${stamp}.bak`));
}

function writeAtomic(p, content) {
  const tmp = `${p}.xsess-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
