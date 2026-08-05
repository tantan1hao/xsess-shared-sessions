/**
 * Claude 桌面版的会话索引 ——
 * `~/Library/Application Support/Claude/claude-code-sessions/<窗口>/<会话组>/local_<uuid>.json`
 *
 * ── 为什么必须有这一层 ──
 * `claude --resume` 扫的是 `~/.claude/projects/`，但**桌面版侧边栏不看那里**。
 * 它读的是这个目录，一条会话一个 JSON。往 projects 写 156 个文件、
 * 字段和真实会话逐个对齐之后，侧边栏里依然一条都不多 —— 就是因为缺这层。
 *
 * 和 Codex 的 `session_index.jsonl` 是同一性质的东西：会话内容归会话内容，
 * 列表归列表，两者分开存。
 *
 * ── 目录的两层 UUID ──
 * 实测本机 28 条记录分布在两组里，而侧边栏显示的恰好是其中一组的全部：
 *   <窗口 uuid>/<会话组 uuid>/
 * 桌面版一次只展示当前窗口那一组，所以写入必须落到**正在用的那组**，
 * 落错组等于没写。判据是组内最大的 lastFocusedAt —— 刚用过的那组就是当前组。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { exists } from '../paths.js';

const ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude-code-sessions',
);

export function desktopIndexAvailable() {
  return exists(ROOT);
}

/**
 * 找桌面版当前在用的那个会话组。
 * @returns {{dir:string, sample:any}|null} dir 是 `<窗口>/<会话组>` 的绝对路径
 */
export function activeSessionGroup() {
  if (!exists(ROOT)) return null;
  /** @type {{dir:string, focused:number, sample:any}[]} */
  const groups = [];

  for (const win of safeReaddir(ROOT)) {
    const winDir = path.join(ROOT, win);
    if (!isDir(winDir)) continue;
    for (const grp of safeReaddir(winDir)) {
      const dir = path.join(winDir, grp);
      if (!isDir(dir)) continue;

      let focused = 0;
      let sample = null;
      for (const f of safeReaddir(dir)) {
        if (!f.endsWith('.json')) continue;
        const j = readJson(path.join(dir, f));
        if (!j) continue;
        const t = Number(j.lastFocusedAt || j.lastActivityAt || j.createdAt || 0);
        if (t > focused) {
          focused = t;
          sample = j;
        }
      }
      if (sample) groups.push({ dir, focused, sample });
    }
  }
  if (!groups.length) return null;
  groups.sort((a, b) => b.focused - a.focused);
  return { dir: groups[0].dir, sample: groups[0].sample };
}

/**
 * 把一条会话登记进桌面版侧边栏。
 *
 * @param {{cliSessionId:string, cwd:string, title:string, at?:Date, write?:boolean}} info
 *   cliSessionId 就是 `~/.claude/projects/**\/<它>.jsonl` 的文件名
 * @returns {{indexed:boolean, reason?:string, path?:string, sessionId?:string}}
 */
export function indexDesktopSession(info) {
  const { cliSessionId, cwd, title, at = new Date(), write = false } = info;

  const group = activeSessionGroup();
  if (!group) {
    return { indexed: false, reason: '找不到桌面版的会话组目录，写进去的会话不会出现在它的侧边栏' };
  }
  if (findByCliSessionId(group.dir, cliSessionId)) {
    return { indexed: false, reason: '已经在侧边栏索引里了' };
  }

  const sessionId = `local_${randomUUID()}`;
  const file = path.join(group.dir, `${sessionId}.json`);
  const ms = at.getTime();
  const s = group.sample;

  // 模型 / effort / 权限模式这些是桌面版自己的运行配置，照抄同组里的真实记录，
  // 不自己编 —— 编出来的枚举值会让整条记录被忽略（Codex 那边栽过）
  const record = {
    sessionId,
    cliSessionId,
    cwd,
    originCwd: cwd,
    lastFocusedAt: ms,
    createdAt: ms,
    lastActivityAt: ms,
    model: s.model,
    effort: s.effort,
    isArchived: false,
    title,
    titleSource: 'auto',
    permissionMode: s.permissionMode,
    remoteMcpServersConfig: [],
    completedTurns: 0,
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    classifierSummaryEnabled: true,
    spawnSeed: {},
  };

  if (!write) return { indexed: false, reason: '预览模式', path: file, sessionId };

  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  return { indexed: true, path: file, sessionId };
}

/** 从侧边栏索引里摘掉。按 cliSessionId 找，因为调用方只认得那个。 */
export function unindexDesktopSession(cliSessionId, { write = false } = {}) {
  if (!exists(ROOT)) return { removed: false };
  let removed = false;
  for (const win of safeReaddir(ROOT)) {
    const winDir = path.join(ROOT, win);
    if (!isDir(winDir)) continue;
    for (const grp of safeReaddir(winDir)) {
      const dir = path.join(winDir, grp);
      if (!isDir(dir)) continue;
      const hit = findByCliSessionId(dir, cliSessionId);
      if (!hit) continue;
      removed = true;
      if (write) {
        try {
          fs.rmSync(hit, { force: true });
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return { removed };
}

/** 在某个组目录里按 cliSessionId 找记录文件 */
function findByCliSessionId(dir, cliSessionId) {
  for (const f of safeReaddir(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dir, f);
    const j = readJson(p);
    if (j && j.cliSessionId === cliSessionId) return p;
  }
  return null;
}

function safeReaddir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
