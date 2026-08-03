/**
 * 适配器注册表。
 *
 * 新增一家工具只需要写一个导出 `adapter` 的模块并挂到这里 ——
 * 扫描器、CLI、MCP、侧边栏都不用改。
 */

import { adapter as claudeCode } from './claude-code.js';
import { adapter as codex } from './codex.js';
import { adapter as geminiCli } from './gemini-cli.js';
import { adapter as antigravity } from './antigravity.js';
import { adapter as cursor } from './cursor.js';

/** @type {import('../model.js').Adapter[]} */
export const ADAPTERS = [claudeCode, codex, antigravity, cursor, geminiCli];

/**
 * 本机装了但没有可解析的本地会话数据的工具 —— 在 doctor 里如实说明，
 * 而不是假装支持。写没法对着真实数据验证的解析器，比不写更糟。
 */
export const UNSUPPORTED = [
  {
    tool: 'trae-cn',
    displayName: 'Trae CN',
    reason: '会话正文不在 state.vscdb（那里只有 turnsHeight 之类的 UI 布局），疑似存在 Chromium LevelDB 或服务端',
  },
  {
    tool: 'kiro',
    displayName: 'Kiro',
    reason: '本机 chat.ChatSessionStore.index 为空，没有可解析的会话；等有数据了再补适配器',
  },
];

export function getAdapter(tool) {
  return ADAPTERS.find((a) => a.tool === tool) || null;
}

/** 只返回本机确实有数据的适配器 */
export function availableAdapters() {
  return ADAPTERS.filter((a) => a.available());
}

export function toolNames() {
  return ADAPTERS.map((a) => a.tool);
}
