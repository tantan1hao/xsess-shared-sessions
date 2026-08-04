/**
 * 本地 HTTP daemon —— VS Code 扩展侧边栏的数据源。
 *
 * 安全设计（这不是过度设计，是必需的）：
 *   1. 只绑 127.0.0.1，不监听外部网卡
 *   2. 强制 Bearer token，token 存在 ~/.xsess/daemon.json（0600）
 *   3. 不开 CORS 通配符
 *
 * 为什么必须要 token：只绑 loopback 挡不住浏览器。你打开的任意一个网页都能
 * `fetch('http://127.0.0.1:10180/api/sessions')` —— 要是再配上 `Access-Control-Allow-Origin: *`，
 * 你所有 AI 会话（代码、密钥、业务细节）就被那个网页读走了。
 * 加了 token 之后，跨站请求拿不到 Authorization 头，读到的只有 401。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listSessions, searchSessions, getSession, getStats, rescan } from '../core/query.js';
import { buildHandoff } from '../core/handoff.js';
import { writeSession, TIER_A } from '../core/writers/index.js';
import { syncStatus, syncMany, unsync } from '../core/sync.js';
import { renderUi } from './ui.js';
import { ADAPTERS, UNSUPPORTED } from '../core/adapters/index.js';
import { XSESS_HOME, ensureXsessDirs } from '../core/paths.js';

export const DEFAULT_PORT = 10180;
const STATE_FILE = path.join(XSESS_HOME, 'daemon.json');
/** 后台自动增量扫描间隔。实测增量扫描 ~70ms，30 秒一次开销可以忽略 */
const AUTO_SCAN_MS = 30_000;

/** 读或建 daemon 状态（含 token）。token 只在本机文件里，不走网络。 */
export function loadState() {
  ensureXsessDirs();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.token) return s;
  } catch {
    /* 不存在或坏了就重建 */
  }
  const state = { token: crypto.randomBytes(32).toString('hex'), port: DEFAULT_PORT };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(STATE_FILE, 0o600);
  return state;
}

export function startDaemon({ port = DEFAULT_PORT, autoScan = true } = {}) {
  const state = loadState();
  state.port = port;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // 预检直接拒 —— 我们不打算支持跨站调用
    if (req.method === 'OPTIONS') return send(res, 403, { error: '不支持跨站请求' });

    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, name: 'xsess', port, pid: process.pid });
    }

    // 管理面板的页面壳子不需要鉴权：它本身不含任何会话数据，
    // 数据全靠下面那些 /api/* 拿，而那些照样要 token。
    if (url.pathname === '/' || url.pathname === '/ui') {
      const html = renderUi();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      });
      return res.end(html);
    }

    if (!authorized(req, state.token)) {
      return send(res, 401, { error: '缺少或错误的 token（在 ~/.xsess/daemon.json）' });
    }

    try {
      await route(req, res, url);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  server.listen(port, '127.0.0.1');

  let timer = null;
  if (autoScan) {
    // 先扫一次再进入定时，让侧边栏一打开就有数据
    rescan().catch(() => {});
    timer = setInterval(() => rescan().catch(() => {}), AUTO_SCAN_MS);
    timer.unref();
  }

  return {
    server,
    state,
    close: () => {
      if (timer) clearInterval(timer);
      server.close();
    },
  };
}

async function route(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/sessions' && req.method === 'GET') {
    const query = q.get('q');
    const opts = {
      tool: q.get('tool') || undefined,
      cwd: q.get('cwd') || undefined,
      limit: Math.min(parseInt(q.get('limit') || '60', 10) || 60, 300),
      includeSubagents: q.get('all') === '1',
    };
    const rows = query ? await searchSessions(query, opts) : await listSessions(opts);
    return send(res, 200, { sessions: rows });
  }

  if (p.startsWith('/api/sessions/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/sessions/'.length));
    const s = await getSession(id, {
      maxMessages: Math.min(parseInt(q.get('max') || '200', 10) || 200, 2000),
    });
    return s ? send(res, 200, s) : send(res, 404, { error: '找不到该会话' });
  }

  // 面板上的「接力到 X」按钮。只允许 Tier A 里那几个真能写回的工具。
  if (p.startsWith('/api/handoff/') && p.endsWith('/write') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/handoff/'.length, -'/write'.length));
    const to = q.get('to');
    if (!TIER_A.includes(to)) {
      return send(res, 400, { error: `不支持写回 ${to}（支持：${TIER_A.join(', ')}）` });
    }
    const pack = await buildHandoff(id);
    if (!pack) return send(res, 404, { error: '找不到该会话' });
    const result = await writeSession(to, pack, { write: true });
    return send(res, 200, result);
  }

  if (p.startsWith('/api/handoff/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/handoff/'.length));
    const pack = await buildHandoff(id, { maxTurns: parseInt(q.get('turns') || '12', 10) || 12 });
    return pack ? send(res, 200, pack) : send(res, 404, { error: '找不到该会话' });
  }

  // ── 同步管理：面板负责开关和挑选，展示还是在各家 IDE 自己的会话列表里 ──

  if (p === '/api/sync' && req.method === 'GET') {
    return send(res, 200, await syncStatus({ to: q.get('to') || 'antigravity' }));
  }

  if (p === '/api/sync' && req.method === 'POST') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return send(res, 400, { error: '没给要同步的会话' });
    return send(
      res,
      200,
      await syncMany(ids, { to: body.to || 'antigravity', write: body.write !== false }),
    );
  }

  if (p === '/api/sync' && req.method === 'DELETE') {
    const body = await readJson(req);
    return send(
      res,
      200,
      await unsync(Array.isArray(body.ids) && body.ids.length ? body.ids : null, {
        to: body.to || 'antigravity',
        write: body.write !== false,
      }),
    );
  }

  if (p === '/api/stats' && req.method === 'GET') {
    return send(res, 200, await getStats());
  }

  if (p === '/api/tools' && req.method === 'GET') {
    return send(res, 200, {
      tools: ADAPTERS.map((a) => ({
        tool: a.tool,
        displayName: a.displayName,
        available: a.available(),
      })),
      unsupported: UNSUPPORTED,
    });
  }

  if (p === '/api/scan' && req.method === 'POST') {
    return send(res, 200, await rescan({ force: q.get('force') === '1' }));
  }

  send(res, 404, { error: `未知路径: ${p}` });
}

/** 读 JSON 请求体，限 1MB —— 面板只会传一批会话 ID，不需要更大 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, token) {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (got.length !== token.length) return false;
  // 定长比较，避免时序侧信道（这里其实无关紧要，但没理由写成不安全的样子）
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
}

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    // 明确拒绝被当作跨站资源使用
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(json);
}
