/**
 * xsess MCP server —— 让 agent 自己查别家工具的会话。
 *
 * 这是整个项目的核心：装上之后，你在 Claude Code 里直接问
 * 「Codex 上周关于 X 聊了什么」，Claude 会自己调 search_sessions 拿到真实内容，
 * 不需要你复制粘贴。Codex 那边同理（它的 config.toml 支持 mcp_servers）。
 *
 * 协议是 JSON-RPC 2.0 over stdio，手写而不引 SDK ——
 * 总共不到 200 行，换来整个项目零依赖、不用管 SDK 的版本漂移。
 */

import readline from 'node:readline';
import { listSessions, searchSessions, getSession, getStats } from '../core/query.js';
import { buildHandoff } from '../core/handoff.js';
import { ADAPTERS } from '../core/adapters/index.js';
import { prefixTitle } from '../core/paths.js';

const SERVER_INFO = { name: 'xsess', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

const TOOL_ENUM = ADAPTERS.map((a) => a.tool);

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      '列出本机各个 AI 编程工具最近的会话（Claude Code / Codex / Antigravity 反重力 / Cursor / Gemini CLI），按更新时间倒序。' +
      '想知道「我最近在别的工具里做了什么」「有没有相关的历史会话」时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: TOOL_ENUM, description: '只看某个工具，不填则全部' },
        cwd: { type: 'string', description: '只看某个项目目录下的会话，通常传当前工作目录' },
        limit: { type: 'integer', default: 30, maximum: 200 },
        includeSubagents: {
          type: 'boolean',
          default: false,
          description: '是否包含子代理/后台会话（Codex 的 guardian 判定会话等），默认排除',
        },
      },
    },
  },
  {
    name: 'search_sessions',
    description:
      '在所有 AI 工具的会话历史里做全文搜索，中文可用。' +
      '当用户提到「之前聊过」「上次那个方案」「在 Codex/反重力里讨论过」时，先用这个查，不要凭空回答。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，中文/英文均可' },
        tool: { type: 'string', enum: TOOL_ENUM },
        limit: { type: 'integer', default: 20, maximum: 100 },
        includeSubagents: { type: 'boolean', default: false },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_session',
    description:
      '读取某个会话的完整对话内容。ID 从 list_sessions / search_sessions 拿，支持前缀。' +
      '超长会话会自动掐头留尾（保留开头定调和结尾进度），避免撑爆上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 ID，如 codex:019a43a5-b2c1-… ，也可只给前缀' },
        maxMessages: { type: 'integer', default: 60, maximum: 400 },
        rolesOnly: {
          type: 'boolean',
          default: true,
          description: '只要用户和 AI 的对话，过滤掉工具调用噪音',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'handoff_session',
    description:
      '把某个会话压缩成「交接包」——目标、已做、待做、关键文件、最后几轮原文。' +
      '用户说「接着 Codex 那个会话继续做」「把反重力里的进度拿过来」时用这个，' +
      '拿到后你就有了完整上下文，可以直接接着干。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要接手的会话 ID' },
        maxTurns: { type: 'integer', default: 12, description: '保留最后几轮原文' },
      },
      required: ['id'],
    },
  },
  {
    name: 'session_stats',
    description: '各工具的会话数量统计，以及哪些工具的索引出了问题。排查「为什么搜不到」时用。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- 工具实现

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_sessions': {
      const rows = await listSessions({
        tool: args.tool,
        cwd: args.cwd,
        limit: Math.min(args.limit || 30, 200),
        includeSubagents: !!args.includeSubagents,
      });
      return rows.length
        ? renderList(rows)
        : '没有会话。可能是索引还没建（在终端跑 `xsess scan`），或者过滤条件太窄。';
    }

    case 'search_sessions': {
      const rows = await searchSessions(args.query, {
        tool: args.tool,
        limit: Math.min(args.limit || 20, 100),
        includeSubagents: !!args.includeSubagents,
      });
      if (!rows.length) return `没有匹配「${args.query}」的会话。`;
      return `「${args.query}」命中 ${rows.length} 个会话：\n\n` + renderList(rows);
    }

    case 'get_session': {
      const s = await getSession(args.id, {
        maxMessages: Math.min(args.maxMessages || 60, 400),
        roles: args.rolesOnly === false ? undefined : ['user', 'assistant', 'unknown', 'system'],
      });
      if (!s) return `找不到会话：${args.id}`;
      return renderSession(s);
    }

    case 'handoff_session': {
      const pack = await buildHandoff(args.id, { maxTurns: args.maxTurns || 12 });
      if (!pack) return `找不到会话：${args.id}`;
      return pack.markdown;
    }

    case 'session_stats': {
      const s = await getStats();
      const lines = s.byTool.map(
        (r) =>
          `- ${r.tool}: ${r.sessions} 个会话` +
          (r.subagents ? `（含 ${r.subagents} 个子代理）` : '') +
          ` / ${r.messages} 条消息，最近 ${r.latest || '未知'}`,
      );
      if (s.failed.length) {
        lines.push(`\n⚠️ ${s.failed.length} 个源解析失败，在终端跑 \`xsess doctor\` 看详情`);
      }
      return `共 ${s.totals.sessions} 个会话 / ${s.totals.messages} 条消息\n\n` + lines.join('\n');
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function renderList(rows) {
  return rows
    .map((r) => {
      // 来源前缀直接进标题（`cc：标题`）：混排列表里不用挪到第二行才知道哪家的
      const bits = [r.updatedAt ? r.updatedAt.slice(0, 16).replace('T', ' ') : '', `${r.messageCount} 条`];
      if (r.cwd) bits.push(r.cwd);
      if (r.model) bits.push(r.model);
      if (r.isSubagent) bits.push('子代理');
      let out = `- **${prefixTitle(r.tool, r.title)}**\n  ${bits.filter(Boolean).join(' · ')}\n  \`${r.id}\``;
      if (r.snippet) out += `\n  > ${r.snippet.replace(/\s+/g, ' ').slice(0, 200)}`;
      return out;
    })
    .join('\n');
}

function renderSession(s) {
  const head = [
    `# ${prefixTitle(s.tool, s.title)}`,
    '',
    `工具: ${s.tool}${s.model ? ` · 模型: ${s.model}` : ''}`,
    s.cwd ? `目录: ${s.cwd}${s.gitBranch ? ` (${s.gitBranch})` : ''}` : null,
    `时间: ${s.startedAt || '?'} → ${s.updatedAt || '?'}`,
    `${s.messageCount} 条消息${s.truncated ? '（已截断）' : ''}`,
    `ID: ${s.id}`,
    '',
    '---',
    '',
  ].filter((x) => x !== null);

  const body = s.messages.map((m) => {
    const who = { user: '用户', assistant: 'AI', tool: '工具', system: '系统', unknown: '?' }[m.role] || m.role;
    return `**${who}**: ${m.text}`;
  });

  return head.join('\n') + body.join('\n\n');
}

// ---------------------------------------------------------------- JSON-RPC

export function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 不是合法 JSON 就忽略，不能因为一行脏数据把服务干掉
    }

    // 通知（没有 id）不需要回复
    const isNotification = msg.id === undefined || msg.id === null;

    try {
      switch (msg.method) {
        case 'initialize':
          reply(msg.id, {
            protocolVersion: msg.params?.protocolVersion || DEFAULT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
          return;

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;

        case 'ping':
          if (!isNotification) reply(msg.id, {});
          return;

        case 'tools/list':
          reply(msg.id, { tools: TOOLS });
          return;

        case 'tools/call': {
          const { name, arguments: args } = msg.params || {};
          try {
            const text = await callTool(name, args || {});
            reply(msg.id, { content: [{ type: 'text', text }] });
          } catch (e) {
            // 工具级错误按 MCP 规范用 isError 返回，而不是 JSON-RPC error ——
            // 这样 agent 能看到错误内容并自己调整，不会当成协议故障
            reply(msg.id, {
              content: [{ type: 'text', text: `xsess 出错: ${e.message}` }],
              isError: true,
            });
          }
          return;
        }

        case 'resources/list':
          reply(msg.id, { resources: [] });
          return;
        case 'prompts/list':
          reply(msg.id, { prompts: [] });
          return;

        default:
          if (!isNotification) fail(msg.id, -32601, `不支持的方法: ${msg.method}`);
      }
    } catch (e) {
      if (!isNotification) fail(msg.id, -32603, e.message);
    }
  });

  return { close: () => rl.close() };
}
