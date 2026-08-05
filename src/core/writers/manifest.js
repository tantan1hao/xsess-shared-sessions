/**
 * 写入清单 —— 记录 xsess 往别家工具目录里创建过哪些文件。
 *
 * 为什么需要：Tier A 的承诺是「只新增、不修改」，所以传统的「改前备份」用不上
 * （没有旧内容要备份）。但你仍然需要一条退路：知道哪些文件是 xsess 造的，
 * 能一键清干净。这份清单就是那条退路。
 */

import fs from 'node:fs';
import path from 'node:path';
import { XSESS_HOME, ensureXsessDirs } from '../paths.js';

const MANIFEST = path.join(XSESS_HOME, 'written.jsonl');

export function recordWrite(entry) {
  ensureXsessDirs();
  const line =
    JSON.stringify({ ...entry, createdAt: new Date().toISOString(), by: 'xsess' }) + '\n';
  fs.appendFileSync(MANIFEST, line, 'utf8');
}

/**
 * 记一笔撤销。
 *
 * 谁执行删除谁记账 —— 之前只有 sync 层记，直接调 writer 的 unwrite 撤掉的
 * （测试就是这么用的）在清单里仍留着写入记录，于是被当成「孤儿」一直挂着。
 *
 * @param {string} tool
 * @param {{targetId?:string, path?:string, sourceSession?:string}} target
 */
export function recordUnwrite(tool, target) {
  recordWrite({
    tool,
    path: target.path || '',
    kind: 'unsync',
    appendedId: target.targetId,
    sourceSession: target.sourceSession,
  });
}

export function listWrites() {
  try {
    return fs
      .readFileSync(MANIFEST, 'utf8')
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
  } catch {
    return [];
  }
}

/**
 * 撤销：删掉 xsess 创建过的会话文件。只删清单里记过的，绝不多删。
 * @param {{write?:boolean, filter?:(e:any)=>boolean}} [opts]
 */
export function revertWrites({ write = false, filter } = {}) {
  const entries = listWrites().filter((e) => (filter ? filter(e) : true));
  const results = [];
  for (const e of entries) {
    const stillThere = fs.existsSync(e.path);
    results.push({ ...e, exists: stillThere, removed: false });
    if (stillThere && write) {
      fs.rmSync(e.path, { force: true });
      results[results.length - 1].removed = true;
    }
  }
  return results;
}

export const MANIFEST_PATH = MANIFEST;
