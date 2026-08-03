/**
 * 各家 AI 工具的会话存储位置。
 *
 * 这些路径全部是本机实测确认过的，不是猜的。改动前先用 `xsess doctor` 验证。
 * 目前只覆盖 macOS —— Linux/Windows 的 Application Support 等价路径留待需要时再补。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = os.homedir();

/** xsess 自己的数据目录（索引库、备份、临时快照） */
export const XSESS_HOME = process.env.XSESS_HOME || path.join(HOME, '.xsess');
export const INDEX_DB = path.join(XSESS_HOME, 'index.db');
export const BACKUP_DIR = path.join(XSESS_HOME, 'backups');
export const TMP_DIR = path.join(XSESS_HOME, 'tmp');
export const HANDOFF_DIR = path.join(XSESS_HOME, 'handoff');

/** macOS 应用数据根目录 */
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support');

/**
 * 每个工具的存储位置 + 展示名 + 短前缀。
 *
 * `prefix` 是会话标题前面那两个字母（cc / cx / ag / cu / gm）。
 * 定在这里是为了让 CLI、MCP 输出、侧边栏、写回的标题四处共用同一套 ——
 * 之前它们各写各的，同一个会话在不同地方长得不一样。
 * `vscdb` 系（Cursor / Trae CN / Kiro）共用同一个适配器，只是路径不同。
 */
export const TOOLS = {
  'claude-code': {
    displayName: 'Claude Code',
    prefix: 'cc',
    projects: path.join(HOME, '.claude', 'projects'),
  },
  codex: {
    displayName: 'Codex',
    prefix: 'cx',
    sessions: path.join(HOME, '.codex', 'sessions'),
    archived: path.join(HOME, '.codex', 'archived_sessions'),
    history: path.join(HOME, '.codex', 'history.jsonl'),
  },
  'gemini-cli': {
    displayName: 'Gemini CLI',
    prefix: 'gm',
    tmp: path.join(HOME, '.gemini', 'tmp'),
  },
  antigravity: {
    displayName: 'Antigravity',
    prefix: 'ag',
    conversations: path.join(HOME, '.gemini', 'antigravity', 'conversations'),
  },
  cursor: {
    displayName: 'Cursor',
    prefix: 'cu',
    vscdb: path.join(APP_SUPPORT, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  },
  'trae-cn': {
    displayName: 'Trae CN',
    prefix: 'tr',
    vscdb: path.join(APP_SUPPORT, 'Trae CN', 'User', 'globalStorage', 'state.vscdb'),
  },
  kiro: {
    displayName: 'Kiro',
    prefix: 'ki',
    vscdb: path.join(APP_SUPPORT, 'Kiro', 'User', 'globalStorage', 'state.vscdb'),
  },
};

/** VS Code 分支们的扩展安装目录，M3 装 .vsix 时用 */
export const EXTENSION_DIRS = {
  antigravity: path.join(HOME, '.antigravity', 'extensions'),
  cursor: path.join(HOME, '.cursor', 'extensions'),
  'trae-cn': path.join(HOME, '.trae-cn', 'extensions'),
  kiro: path.join(HOME, '.kiro', 'extensions'),
  vscode: path.join(HOME, '.vscode', 'extensions'),
};

/** MCP 注册点，M4 用 */
export const MCP_CONFIGS = {
  'claude-code': path.join(HOME, '.claude.json'),
  codex: path.join(HOME, '.codex', 'config.toml'),
};

export function ensureXsessDirs() {
  for (const d of [XSESS_HOME, BACKUP_DIR, TMP_DIR, HANDOFF_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code 把 cwd 编码进目录名（`/Users/you/code/my-app` → `-Users-you-code-my-app`）。
 * 这个编码是有损的（`/` 和非 ASCII 都变 `-`），所以反解只能靠会话内的 `cwd` 字段，
 * 不能从目录名还原 —— 适配器里就是这么做的。
 */
export function encodeClaudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 工具的短前缀，用于会话标题：`cc：会话标题`。
 * 未知工具退回名字前两个字母，不返回空 —— 没有前缀的标题在混排列表里认不出来源。
 */
export function toolPrefix(tool) {
  return (TOOLS[tool] && TOOLS[tool].prefix) || String(tool || '??').slice(0, 2).toLowerCase();
}

/** 所有已知前缀，用于剥掉标题上已有的那个 */
const KNOWN_PREFIXES = Object.values(TOOLS).map((t) => t.prefix);

/**
 * 剥掉标题开头已有的工具前缀。
 *
 * 接力写回时，标题里存的是**来源**工具的前缀（`ag：X`）——
 * 这样在 Claude Code 自己的 `--resume` 列表里能一眼看出这条是搬过来的。
 * 但在 xsess 的混排列表里，这条会话现在归属 Claude Code，
 * 不剥就会变成 `cc：ag：X`，多接力几次还会一路累积成 `cc：cx：ag：X`。
 */
export function stripTitlePrefix(title) {
  let t = String(title == null ? '' : title);
  // 循环剥：万一历史数据里已经攒了 `cc：cx：ag：` 这种，一次只剥一层是清不掉的。
  // 上限 4 层，免得把真的以 `xx：` 开头的标题内容也吃掉。
  for (let i = 0; i < 4; i++) {
    const hit = KNOWN_PREFIXES.find((p) => t.startsWith(`${p}：`));
    if (!hit) break;
    t = t.slice(hit.length + 1);
  }
  return t;
}

/**
 * 给标题加上工具前缀：`cc：会话标题`。
 * 幂等，且不会叠加 —— 已有的前缀先剥掉再换成新的。
 */
export function prefixTitle(tool, title) {
  return `${toolPrefix(tool)}：${stripTitlePrefix(title)}`;
}
