/**
 * 只读打开别家工具的 SQLite 库，**不在人家目录里留任何文件**。
 *
 * 这里有个容易踩的坑：用 `?mode=ro` 打开一个 WAL 模式的库，SQLite 仍然会
 * 创建 `-shm` 和 `-wal` 两个伴生文件 —— 只读打开也会写。
 * 实测：xsess 每扫一次 Antigravity，就在它的 conversations/ 里多留几十个垃圾文件。
 * 这违背了「对各家工具的会话目录只读」这条承诺。
 *
 * `?immutable=1` 什么都不留，但它只读主库文件，会漏掉 WAL 里尚未 checkpoint 的数据 ——
 * 也就是最近的那几条消息，恰恰是最想要的。
 *
 * 所以按情况分流：
 *   - 有非空 WAL  → 快照整套（db + wal + shm）到临时目录再读，保证读到最新数据
 *   - 没有 WAL    → immutable 直读，零开销零副作用
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TMP_DIR } from './paths.js';

/**
 * @param {string} dbPath
 * @param {{sentinelTable?:string}} [opts] 打开后试读一下这张表，确认真的能用
 * @returns {{db: DatabaseSync, removeFiles: () => void}}
 *   removeFiles 只负责删临时快照，**不关闭连接** ——
 *   让它也管关闭的话，调用方包装 db.close 时会和它互相调用，直接爆栈（踩过）。
 */
export function openReadOnlySafe(dbPath, opts = {}) {
  const { sentinelTable } = opts;
  const wal = `${dbPath}-wal`;

  let walSize = 0;
  try {
    walSize = fs.statSync(wal).size;
  } catch {
    /* 没有 WAL，正常 */
  }

  if (walSize === 0) {
    try {
      const db = new DatabaseSync(`file:${encodeURI(dbPath)}?mode=ro&immutable=1`, {
        readOnly: true,
      });
      if (sentinelTable) db.prepare(`SELECT 1 FROM "${sentinelTable}" LIMIT 1`).get();
      return { db, removeFiles: () => {} }; // 没有快照，没东西要删
    } catch {
      // immutable 读不了（比如库本身有未回放的日志），退回快照
    }
  }

  return openViaSnapshot(dbPath, sentinelTable);
}

/**
 * 把 db + wal + shm 一起复制到临时目录再读。
 * 三个文件要一起复制 —— 只拷主库会丢掉 WAL 里的新数据，
 * 只拷 db+wal 而 shm 不一致则可能读不出来。
 */
function openViaSnapshot(dbPath, sentinelTable) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const snap = path.join(TMP_DIR, `snap-${process.pid}-${path.basename(dbPath)}`);

  const copied = [];
  try {
    fs.copyFileSync(dbPath, snap);
    copied.push(snap);
    for (const ext of ['-wal', '-shm']) {
      try {
        fs.copyFileSync(dbPath + ext, snap + ext);
        copied.push(snap + ext);
      } catch {
        /* 没这个伴生文件 */
      }
    }
    const db = new DatabaseSync(`file:${encodeURI(snap)}?mode=ro`, { readOnly: true });
    if (sentinelTable) db.prepare(`SELECT 1 FROM "${sentinelTable}" LIMIT 1`).get();
    return {
      db,
      removeFiles: () => {
        // 快照自己产生的 wal/shm 也要清，别在临时目录堆积
        for (const p of [...copied, `${snap}-wal`, `${snap}-shm`]) {
          try {
            fs.rmSync(p, { force: true });
          } catch {
            /* 忽略 */
          }
        }
      },
    };
  } catch (e) {
    for (const p of copied) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 忽略 */
      }
    }
    throw new Error(`打不开 ${path.basename(dbPath)}：${e.message}`);
  }
}
