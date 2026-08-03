/**
 * 终端输出格式化。无依赖，尊重 NO_COLOR 和非 TTY。
 */

import { TOOLS, toolPrefix } from '../core/paths.js';

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
  orange: wrap('38;5;208'),
};

/**
 * 每家工具的配色。短标签本身来自 paths.js 的 `prefix`，不在这里重复定义 ——
 * 之前 CLI、MCP、侧边栏各写各的标签，同一个会话在三处长得不一样。
 */
const TOOL_COLOR = {
  'claude-code': c.orange,
  codex: c.green,
  'gemini-cli': c.blue,
  antigravity: c.magenta,
  cursor: c.cyan,
  'trae-cn': c.yellow,
  kiro: c.red,
};

export function toolTag(tool) {
  const color = TOOL_COLOR[tool] || c.gray;
  return color(toolPrefix(tool));
}

export function toolName(tool) {
  return (TOOLS[tool] && TOOLS[tool].displayName) || tool;
}

/**
 * 带来源前缀的标题：`cc：会话标题`。
 * 前缀染色、标题保持原色，混排列表里扫一眼就知道哪条来自哪家。
 * 截断只作用于标题本身，不会把前缀切掉。
 */
export function prefixedTitle(tool, title, maxTitleWidth) {
  const color = TOOL_COLOR[tool] || c.gray;
  const body = maxTitleWidth ? truncWidth(title || '(无标题)', maxTitleWidth) : title || '(无标题)';
  return color(`${toolPrefix(tool)}：`) + body;
}

/** 前缀部分占的显示宽度（两个 ASCII 字母 + 一个全角冒号） */
export const PREFIX_WIDTH = 4;

/** 中文相对时间。绝对时间在会话列表里几乎没用，相对的才有用。 */
export function relTime(iso) {
  if (!iso) return '  —  ';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '  —  ';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon} 个月前`;
  return `${Math.floor(mon / 12)} 年前`;
}

/** 匹配 ANSI 转义序列 —— 它们不占显示宽度，算进去表格会错位 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

/** 东亚宽字符占两列，不按显示宽度对齐的话表格会全歪 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
        ? 2
        : 1;
  }
  return w;
}

export function padEnd(s, width) {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 按显示宽度截断，避免半个汉字或者撑破终端 */
export function truncWidth(s, width) {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function humanCount(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

/** 把绝对路径缩成 `~/…/最后两级`，列表里够认了 */
export function shortPath(p, home = process.env.HOME) {
  if (!p) return '';
  let s = home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  const parts = s.split('/');
  if (parts.length > 4) s = parts[0] + '/…/' + parts.slice(-2).join('/');
  return s;
}
