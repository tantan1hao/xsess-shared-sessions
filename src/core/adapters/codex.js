/**
 * Codex 适配器 —— `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *
 * 每行 `{timestamp, type, payload}`，type ∈
 *   session_meta   一次 rollout 的头（cwd / originator / cli_version / thread_source）
 *   turn_context   本轮上下文（model / approval_policy / sandbox）
 *   event_msg      UI 事件流，正文最干净：user_message / agent_message
 *   response_item  发给模型的原始条目（含 developer 指令、reasoning）
 *   world_state    环境快照，与内容无关
 *
 * 坑：301 个 rollout 里有相当一部分是 guardian / 子代理会话（`thread_source:"subagent"`），
 * 正文是「判定某个动作风险」的模板，不是真对话。标成 isSubagent 让列表默认折叠，
 * 否则你的会话栏会被这些淹掉。
 */

import { TOOLS, exists } from '../paths.js';
import { readJsonl, walkFiles } from '../jsonl.js';
import { cleanText, makeSession, toIso } from '../model.js';

const TOOL = 'codex';

export const adapter = {
  tool: TOOL,
  displayName: TOOLS[TOOL].displayName,

  available() {
    return exists(TOOLS[TOOL].sessions);
  },

  async discover() {
    const roots = [TOOLS[TOOL].sessions, TOOLS[TOOL].archived].filter(exists);
    const out = [];
    for (const root of roots) {
      for (const f of walkFiles(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
        out.push({
          sourceId: `${TOOL}:${f.path}`,
          path: f.path,
          mtimeMs: f.mtimeMs,
          size: f.size,
          archived: root === TOOLS[TOOL].archived,
        });
      }
    }
    return out;
  },

  async parse(src) {
    /** @type {any} */
    let meta = null;
    let model = null;
    let firstTs = null;
    let lastTs = null;
    const eventMessages = [];
    const itemMessages = [];

    await readJsonl(src.path, (rec) => {
      if (rec.timestamp) {
        if (!firstTs) firstTs = rec.timestamp;
        lastTs = rec.timestamp;
      }
      const p = rec.payload || {};

      switch (rec.type) {
        case 'session_meta':
          if (!meta) meta = p;
          break;
        case 'turn_context':
          if (p.model) model = p.model;
          break;
        case 'event_msg': {
          const m = fromEvent(p, rec.timestamp);
          if (m) eventMessages.push(m);
          break;
        }
        case 'response_item': {
          const m = fromResponseItem(p, rec.timestamp);
          if (m) itemMessages.push(m);
          break;
        }
        default:
          break; // world_state 之类跳过
      }
    });

    // event_msg 是给人看的干净流，优先；某些旧 rollout 只有 response_item，退回去用
    const messages = eventMessages.length ? eventMessages : itemMessages;

    const nativeId =
      (meta && (meta.id || meta.session_id)) || idFromFilename(src.path) || src.path;

    const isSubagent =
      !!(meta && (meta.thread_source === 'subagent' || (meta.source && meta.source.subagent)));

    return [
      makeSession({
        tool: TOOL,
        nativeId,
        title: null, // Codex 不存标题，靠首条用户消息推
        cwd: (meta && meta.cwd) || null,
        gitBranch: null,
        model: model || (meta && meta.model) || null,
        startedAt: toIso((meta && meta.timestamp) || firstTs),
        updatedAt: toIso(lastTs),
        isSubagent,
        sourceId: src.sourceId,
        path: src.path,
        meta: {
          originator: meta && meta.originator,
          cliVersion: meta && meta.cli_version,
          modelProvider: meta && meta.model_provider,
          parentThreadId: meta && meta.parent_thread_id,
          threadSource: meta && meta.thread_source,
          subagentKind: meta && meta.source && meta.source.subagent,
          archived: !!src.archived,
        },
        messages,
      }),
    ];
  },
};

function fromEvent(p, ts) {
  switch (p.type) {
    case 'user_message': {
      const text = cleanText(p.message);
      return text ? { role: 'user', text, ts: toIso(ts) } : null;
    }
    case 'agent_message': {
      const text = cleanText(p.message);
      return text ? { role: 'assistant', text, ts: toIso(ts) } : null;
    }
    default:
      // agent_reasoning / token_count / task_started / task_complete 都不进正文
      return null;
  }
}

function fromResponseItem(p, ts) {
  if (p.type !== 'message') return null;
  const text = cleanText(
    (Array.isArray(p.content) ? p.content : [])
      .map((b) => (b && typeof b === 'object' ? b.text : ''))
      .filter(Boolean)
      .join('\n'),
  );
  if (!text) return null;
  const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system';
  return { role, text, ts: toIso(ts) };
}

/** rollout-2026-08-03T17-35-47-019fc6fa-b64b-77d0-bc1c-6fa1b7d8b270.jsonl → 尾部 UUID */
function idFromFilename(p) {
  const name = p.split('/').pop() || '';
  const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : null;
}
