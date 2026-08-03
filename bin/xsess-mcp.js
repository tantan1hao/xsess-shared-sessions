#!/usr/bin/env node
/**
 * MCP server 入口（stdio）。
 *
 * 注册到 Claude Code：  xsess mcp install --tool claude-code
 * 注册到 Codex：        xsess mcp install --tool codex
 *
 * stdout 是协议通道，任何调试输出都必须走 stderr —— 往 stdout 打一个字节就会
 * 破坏 JSON-RPC 帧，客户端表现是「MCP 服务连不上」，很难查。
 */
process.removeAllListeners('warning');
process.on('warning', () => {});

import { startMcpServer } from '../src/mcp/server.js';

startMcpServer();

const describe = (/** @type {any} */ e) => (e && e.stack ? e.stack : String(e));
process.on('uncaughtException', (e) => {
  process.stderr.write(`[xsess-mcp] 未捕获异常: ${describe(e)}\n`);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[xsess-mcp] 未处理的 rejection: ${describe(e)}\n`);
});
