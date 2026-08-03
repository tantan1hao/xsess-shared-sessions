/**
 * 把 xsess 的 MCP server 注册进 Claude Code 和 Codex。
 *
 * 这两个文件是你天天在用的工具配置，改坏了很烦，所以：
 *   - 改之前一律备份到 ~/.xsess/backups/
 *   - 幂等：已经装过就说「已装」，不重复写
 *   - 默认 dry-run，看清楚要改什么再 --write
 *   - Codex 的 TOML 用追加而不是重写整个文件 —— 不解析就不会解析错，
 *     你那份 config.toml 里有 7000 字节的既有配置，不值得为一个 block 冒险
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_CONFIGS, BACKUP_DIR, ensureXsessDirs, exists } from '../core/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_ENTRY = path.resolve(HERE, '../../bin/xsess-mcp.js');
const SERVER_NAME = 'xsess';

/**
 * @typedef {Object} InstallResult
 * @property {string} tool
 * @property {string} action   skip|already|would-add|added|would-remove|removed|absent|error
 * @property {string} detail
 * @property {string} [preview] 预览模式下展示将要写入的内容
 */

/** @returns {{tool:string, installed:boolean, detail:string}[]} */
export function status() {
  return [claudeStatus(), codexStatus()];
}

function claudeStatus() {
  const p = MCP_CONFIGS['claude-code'];
  if (!exists(p)) return { tool: 'claude-code', installed: false, detail: `${p} 不存在` };
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const entry = cfg.mcpServers && cfg.mcpServers[SERVER_NAME];
    return {
      tool: 'claude-code',
      installed: !!entry,
      detail: entry ? `已注册 → ${(entry.args || []).join(' ')}` : '未注册',
    };
  } catch (e) {
    return { tool: 'claude-code', installed: false, detail: `配置读不了: ${e.message}` };
  }
}

function codexStatus() {
  const p = MCP_CONFIGS.codex;
  if (!exists(p)) return { tool: 'codex', installed: false, detail: `${p} 不存在` };
  const text = fs.readFileSync(p, 'utf8');
  const has = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(text);
  return { tool: 'codex', installed: has, detail: has ? '已注册' : '未注册' };
}

/**
 * @param {{tools?:string[], write?:boolean}} opts
 * @returns {InstallResult[]}
 */
export function install(opts = {}) {
  const { tools = ['claude-code', 'codex'], write = false } = opts;
  const results = [];
  if (tools.includes('claude-code')) results.push(installClaude(write));
  if (tools.includes('codex')) results.push(installCodex(write));
  return results;
}

/** @returns {InstallResult} */
function installClaude(write) {
  const p = MCP_CONFIGS['claude-code'];
  if (!exists(p)) return { tool: 'claude-code', action: 'skip', detail: `${p} 不存在` };

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { tool: 'claude-code', action: 'error', detail: `JSON 解析失败: ${e.message}` };
  }

  if (cfg.mcpServers && cfg.mcpServers[SERVER_NAME]) {
    return { tool: 'claude-code', action: 'already', detail: '已注册，跳过' };
  }

  const entry = { command: process.execPath, args: [MCP_ENTRY] };
  const preview = `${p}\n  mcpServers.${SERVER_NAME} = ${JSON.stringify(entry, null, 2)}`;

  if (!write) return { tool: 'claude-code', action: 'would-add', detail: '未写入（加 --write 执行）', preview };

  backup(p);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers[SERVER_NAME] = entry;
  writeAtomic(p, JSON.stringify(cfg, null, 2) + '\n');
  return { tool: 'claude-code', action: 'added', detail: `已写入 ${p}`, preview };
}

/** @returns {InstallResult} */
function installCodex(write) {
  const p = MCP_CONFIGS.codex;
  if (!exists(p)) return { tool: 'codex', action: 'skip', detail: `${p} 不存在` };

  const text = fs.readFileSync(p, 'utf8');
  if (new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm').test(text)) {
    return { tool: 'codex', action: 'already', detail: '已注册，跳过' };
  }

  const block =
    `\n[mcp_servers.${SERVER_NAME}]\n` +
    `command = ${toml(process.execPath)}\n` +
    `args = [${toml(MCP_ENTRY)}]\n` +
    `startup_timeout_sec = 30\n`;

  const preview = `${p}（追加到末尾）\n${block}`;
  if (!write) return { tool: 'codex', action: 'would-add', detail: '未写入（加 --write 执行）', preview };

  backup(p);
  // 追加而不是重写：不碰你已有的 7KB 配置，出错面积最小
  writeAtomic(p, text.replace(/\n*$/, '\n') + block);
  return { tool: 'codex', action: 'added', detail: `已追加到 ${p}`, preview };
}

/**
 * @param {{tools?:string[], write?:boolean}} [opts]
 * @returns {InstallResult[]}
 */
export function uninstall(opts = {}) {
  const { tools = ['claude-code', 'codex'], write = false } = opts;
  /** @type {InstallResult[]} */
  const results = [];

  if (tools.includes('claude-code')) {
    const p = MCP_CONFIGS['claude-code'];
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cfg.mcpServers && cfg.mcpServers[SERVER_NAME]) {
        if (write) {
          backup(p);
          delete cfg.mcpServers[SERVER_NAME];
          writeAtomic(p, JSON.stringify(cfg, null, 2) + '\n');
        }
        results.push({ tool: 'claude-code', action: write ? 'removed' : 'would-remove', detail: p });
      } else {
        results.push({ tool: 'claude-code', action: 'absent', detail: '本来就没注册' });
      }
    } catch (e) {
      results.push({ tool: 'claude-code', action: 'error', detail: e.message });
    }
  }

  if (tools.includes('codex')) {
    const p = MCP_CONFIGS.codex;
    const text = exists(p) ? fs.readFileSync(p, 'utf8') : '';
    // 删掉 [mcp_servers.xsess] 到下一个 section 之前的内容
    const re = new RegExp(`\\n\\[mcp_servers\\.${SERVER_NAME}\\][^\\[]*`, 'g');
    if (re.test(text)) {
      if (write) {
        backup(p);
        writeAtomic(p, text.replace(re, '\n'));
      }
      results.push({ tool: 'codex', action: write ? 'removed' : 'would-remove', detail: p });
    } else {
      results.push({ tool: 'codex', action: 'absent', detail: '本来就没注册' });
    }
  }

  return results;
}

// ---------------------------------------------------------------- 工具

function backup(p) {
  ensureXsessDirs();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 去掉开头的点：源文件叫 .claude.json，照抄的话备份也变成隐藏文件，
  // `ls ~/.xsess/backups` 看不到 —— 看不见的备份等于没有备份
  const name = path.basename(p).replace(/^\.+/, '');
  const dest = path.join(BACKUP_DIR, `${name}.${stamp}.bak`);
  fs.copyFileSync(p, dest);
  return dest;
}

/** 先写临时文件再 rename：中途崩了也不会留下半截配置 */
function writeAtomic(p, content) {
  const tmp = `${p}.xsess-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

/** TOML 基础字符串字面量。路径里出现引号或反斜杠的概率极低，但转义了不亏。 */
function toml(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
