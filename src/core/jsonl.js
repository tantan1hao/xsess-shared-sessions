/**
 * JSONL 流式读取。
 *
 * 用流而不是 readFileSync 是有必要的：Claude Code 的单个会话文件实测 2MB+，
 * Codex 有 301 个 rollout —— 全量塞进内存再 split 会在扫描时峰值很难看。
 */

import fs from 'node:fs';
import readline from 'node:readline';

/**
 * 逐行解析 JSONL。解析不了的行跳过并计数，不抛异常 ——
 * 会话文件可能正在被写入，最后一行截断是常态，不该让整个源报错。
 *
 * @param {string} file
 * @param {(rec: any, lineNo: number) => void} onRecord
 * @returns {Promise<{lines:number, parsed:number, skipped:number}>}
 */
export async function readJsonl(file, onRecord) {
  const stat = { lines: 0, parsed: 0, skipped: 0 };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      stat.lines++;
      if (!line || !line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        stat.skipped++;
        continue;
      }
      stat.parsed++;
      onRecord(rec, stat.lines);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return stat;
}

/** 递归找匹配的文件，返回带 stat 的结果 */
export function walkFiles(dir, matchFn, { maxDepth = 8 } = {}) {
  /** @type {Array<{path:string, mtimeMs:number, size:number}>} */
  const out = [];
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: d, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // 权限不足或目录消失，跳过而不是崩掉整次扫描
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) {
        stack.push({ dir: p, depth: depth + 1 });
      } else if (e.isFile() && matchFn(e.name, p)) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* 文件刚被删，忽略 */
        }
      }
    }
  }
  return out;
}
