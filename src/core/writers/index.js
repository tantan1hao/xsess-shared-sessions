/**
 * 写回器注册表。
 *
 * ── 为什么只有两家 ──
 * Tier A（这里的两个）存的是明文 JSONL，格式已完整逆向，可以安全地生成
 * 一个新会话文件让对方 `--resume` 认出来。
 *
 * Tier B（Antigravity / Cursor / Trae / Kiro）不在这里，不是没做，是**不该做**：
 *   - Cursor 的 state.vscdb 本机 390MB，运行时开着 WAL 在写，
 *     并发写入等于拿你全部历史赌一把
 *   - Antigravity 是无 schema 的 protobuf。逆向「读」和逆向「写」难度差一个量级：
 *     读错了顶多显示得糙，写错了是静默损坏，而且要等你下次打开那个会话才发现
 *
 * 它们走注入式接力：`xsess handoff <id>` 生成交接包落盘，
 * 在 IDE 里 @ 引用那个文件 —— 对你来说同样是一键继续，但零损坏风险。
 */

import { writeClaudeCodeSession } from './claude-code.js';
import { writeCodexSession } from './codex.js';
import { writeAntigravitySession } from './antigravity.js';

/**
 * 支持真·文件级写回的工具。
 *
 * Antigravity 后来也进来了 —— 摸清结构后发现它需要的同样是「追加 + 新建」而不是改写：
 * 会话索引 `agyhub_summaries_proto.pb` 的顶层是纯 repeated 字段，
 * 新增一条等于在文件尾接一段字节，已有内容零改动。
 * 正文则写进新建的 conversations/<新uuid>.db。安全等级和上面两家相同。
 */
export const TIER_A = ['claude-code', 'codex', 'antigravity'];

const WRITERS = {
  'claude-code': writeClaudeCodeSession,
  codex: writeCodexSession,
  antigravity: writeAntigravitySession,
};

/**
 * @param {string} tool 目标工具
 * @param {any} pack buildHandoff 的产物
 * @param {{write?:boolean, allowWhileRunning?:boolean}} [opts]
 *   write=false 只预览，不落盘；
 *   allowWhileRunning 只对 antigravity 有意义（它要求先退出应用）
 */
export async function writeSession(tool, pack, opts = {}) {
  const fn = WRITERS[tool];
  if (!fn) throw new Error(`不支持写回 ${tool}（支持的：${TIER_A.join(', ')}）`);
  return fn(pack, opts);
}

export { listWrites, revertWrites, MANIFEST_PATH } from './manifest.js';
