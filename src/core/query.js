/**
 * 查询层 —— CLI / MCP / HTTP 三个入口共用的业务逻辑。
 *
 * 放在这里而不是让 MCP 去 shell 调 CLI：进程启动开销省掉了，
 * 更重要的是三个入口的行为保证一致（同一个「新鲜度」策略、同一套过滤规则）。
 */

import { openIndex } from './index-db.js';
import { scan } from './scanner.js';
import { ensureXsessDirs, INDEX_DB, exists, toolPrefix } from './paths.js';

/** 索引超过这个时间没扫过，读之前先补一次增量扫描（实测 68ms，几乎无感） */
const STALE_MS = 60_000;

let lastScanAt = 0;

/**
 * 打开索引，必要时先增量扫一遍。
 * MCP / HTTP 是长驻进程，不这么做的话 agent 查到的永远是启动那一刻的快照。
 */
export async function openFresh({ force = false } = {}) {
  ensureXsessDirs();
  const needScan = force || !exists(INDEX_DB) || Date.now() - lastScanAt > STALE_MS;
  const index = openIndex();
  if (needScan) {
    try {
      await scan(index, { force: false });
      lastScanAt = Date.now();
    } catch {
      // 扫描失败就用现有索引顶上 —— 陈旧的结果远好过没有结果
    }
  }
  return index;
}

/**
 * 把会话压成给 agent / 前端看的紧凑对象，不带整段正文。
 *
 * `prefix` 一并带出去，是为了让侧边栏扩展不用自己维护一份工具→标签的映射表。
 * 扩展是独立部署的，import 不到 core，复制一份映射迟早会和这边不一致。
 */
export function summarize(s) {
  return {
    id: s.id,
    tool: s.tool,
    prefix: toolPrefix(s.tool),
    title: s.title,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    model: s.model,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    isSubagent: s.isSubagent,
    ...(s.snippet ? { snippet: s.snippet } : {}),
  };
}

/** @param {{tool?:string, cwd?:string, limit?:number, offset?:number, includeSubagents?:boolean, since?:string}} [opts] */
export async function listSessions(opts = {}) {
  const index = await openFresh();
  try {
    return index.listSessions(opts).map(summarize);
  } finally {
    index.close();
  }
}

/**
 * @param {string} query
 * @param {{tool?:string, limit?:number, includeSubagents?:boolean}} [opts]
 */
export async function searchSessions(query, opts = {}) {
  const index = await openFresh();
  try {
    return index.searchSessions(query, opts).map(summarize);
  } finally {
    index.close();
  }
}

/**
 * 取整个会话。maxMessages 是给 MCP 用的 ——
 * 一个 2714 条消息的 Codex 会话直接怼给 agent 会把上下文撑爆，
 * 所以默认掐头留尾：开头几轮定基调，结尾几轮是当前进度。
 */
/**
 * @param {string} id
 * @param {{maxMessages?:number, roles?:string[]}} [opts]
 */
export async function getSession(id, { maxMessages = 60, roles } = {}) {
  const index = await openFresh();
  try {
    const resolved = index.resolveId(id) || id;
    const s = index.getSession(resolved);
    if (!s) return null;

    let messages = s.messages;
    if (roles && roles.length) messages = messages.filter((m) => roles.includes(m.role));

    const truncated = messages.length > maxMessages;
    if (truncated) {
      const head = Math.ceil(maxMessages / 3);
      const tail = maxMessages - head;
      messages = [
        ...messages.slice(0, head),
        { role: 'system', text: `⟨略去中间 ${messages.length - maxMessages} 条⟩` },
        ...messages.slice(-tail),
      ];
    }
    return { ...summarize(s), path: s.path, meta: s.meta, truncated, messages };
  } finally {
    index.close();
  }
}

export async function getStats() {
  const index = await openFresh();
  try {
    return index.stats();
  } finally {
    index.close();
  }
}

/**
 * @param {{force?:boolean, tools?:string[]}} [opts]
 */
export async function rescan({ force = false, tools } = {}) {
  ensureXsessDirs();
  const index = openIndex();
  try {
    const report = await scan(index, { force, tools });
    lastScanAt = Date.now();
    return report;
  } finally {
    index.close();
  }
}
