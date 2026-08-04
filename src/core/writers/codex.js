/**
 * 写回 Codex —— 生成一个新的 rollout 文件，让 `codex resume` 能直接接上。
 *
 * 安全边界同 Claude Code：只新建 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，
 * 不碰任何已有文件。
 *
 * 文件名格式必须照抄真实的那套（`rollout-<本地时间>-<uuid>.jsonl`），
 * Codex 按目录日期和文件名排序列出会话，名字不对就不会出现在列表里。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TOOLS, exists, prefixTitle } from '../paths.js';
import { recordWrite } from './manifest.js';
import { indexCodexThread } from './codex-index.js';

const SESSIONS = TOOLS.codex.sessions;
const FALLBACK_CLI_VERSION = '0.146.0-alpha.9.2';

/**
 * @param {import('../handoff.js').HandoffPack} pack
 * @param {{write?:boolean}} [opts]
 */
export function writeCodexSession(pack, { write = false } = {}) {
  const cwd = pack.cwd || process.cwd();
  const id = randomUUID();
  const now = new Date();

  const dir = path.join(
    SESSIONS,
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  );
  const file = path.join(dir, `rollout-${localStamp(now)}-${id}.jsonl`);

  const lines = [];
  let tick = 0;
  const ts = () => new Date(now.getTime() + tick++).toISOString();

  lines.push({
    timestamp: ts(),
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      timestamp: now.toISOString(),
      cwd,
      // originator / source 是 Codex 认的枚举，不能自己编。
      // 实测写 'xsess' 的后果：app-server 扫到这个文件后把 threads.source
      // 记成 'unknown'，会话就从 codex resume 的列表里被过滤掉。
      // 来源标识改由标题前缀（cc：/ ag：…）和 ~/.xsess/written.jsonl 承担。
      originator: 'codex-tui',
      cli_version: detectCliVersion(),
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
    },
  });

  const msg = (role, text) => ({
    timestamp: ts(),
    type: 'response_item',
    payload: {
      type: 'message',
      id: `msg_${randomUUID()}`,
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
  });
  // event_msg 是 TUI 渲染用的流；两者都写，resume 列表和回放才都正常
  const event = (type, message) => ({
    timestamp: ts(),
    type: 'event_msg',
    payload: { type, message },
  });

  lines.push(msg('user', pack.header));
  lines.push(event('user_message', pack.header));

  for (const t of pack.turns) {
    const role = t.role === 'user' ? 'user' : 'assistant';
    lines.push(msg(role, t.text));
    lines.push(event(role === 'user' ? 'user_message' : 'agent_message', t.text));
  }

  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  const result = {
    tool: 'codex',
    path: file,
    sessionId: id,
    // 带源工具前缀：codex resume 列表里一眼看出这条是搬过来的
    title: prefixTitle(pack.tool, pack.title),
    messageCount: pack.turns.length + 1,
    resumeHint: `codex resume`,
  };

  if (!write) return result;

  fs.mkdirSync(dir, { recursive: true });
  if (exists(file)) throw new Error(`目标文件已存在，不覆盖：${file}`);
  fs.writeFileSync(file, content, 'utf8');
  recordWrite({ tool: 'codex', path: file, sourceSession: pack.sessionId });

  // 光有文件还不够：codex resume 的列表读的是 state 库里的 threads 表，
  // 不登记的话文件写得再对也不会出现在列表里（实测过）。
  const idx = indexCodexThread({
    id,
    rolloutPath: file,
    cwd,
    title: result.title,
    firstUserMessage: pack.header,
    cliVersion: detectCliVersion(),
    at: now,
    write: true,
  });
  result.indexed = idx.indexed;
  if (idx.indexed) {
    recordWrite({ tool: 'codex', path: idx.db, kind: 'index', appendedId: id, sourceSession: pack.sessionId });
  } else {
    // 登记失败不回滚文件 —— 文件本身是有效的，
    // 只是要靠 `codex resume <id>` 直接指定才能打开
    result.indexWarning = idx.reason;
  }
  return result;
}

/** `2026-08-03T17-35-47` —— 本地时间，跟 Codex 自己的命名一致 */
function localStamp(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 从最近的 rollout 里读 Codex 版本号 */
function detectCliVersion() {
  try {
    const years = fs.readdirSync(SESSIONS).sort().reverse();
    for (const y of years) {
      const stack = [path.join(SESSIONS, y)];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.startsWith('rollout-')) {
            const first = fs.readFileSync(p, 'utf8').split('\n', 1)[0];
            const v = JSON.parse(first)?.payload?.cli_version;
            if (v) return v;
          }
        }
      }
    }
  } catch {
    /* 读不到就用兜底 */
  }
  return FALLBACK_CLI_VERSION;
}
