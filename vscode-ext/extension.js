/**
 * xsess 侧边栏扩展。
 *
 * 一份代码同时跑在 VS Code / Cursor / Antigravity / Trae CN / Kiro ——
 * 它们都是 VS Code 分支，扩展 API 相同。
 *
 * 刻意用纯 CommonJS JavaScript 而不是 TypeScript：
 * VS Code 扩展本来就直接吃 JS，不编译就意味着「拷进 extensions 目录、重启 IDE」
 * 这一条路走完就装好了，不需要 vsce、不需要 npm install、不需要 tsc。
 *
 * 数据全部来自本地 daemon（127.0.0.1 + token），扩展自己不碰任何会话文件。
 */

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { renderHtml } = require('./webview.js');

const XSESS_HOME = path.join(os.homedir(), '.xsess');
const DAEMON_STATE = path.join(XSESS_HOME, 'daemon.json');

let daemonProcess = null;

function activate(context) {
  const provider = new SessionsViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('xsess.sessions', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('xsess.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('xsess.openHandoff', (id) => provider.handoff(id)),
    vscode.commands.registerCommand('xsess.restartDaemon', async () => {
      killDaemon();
      await ensureDaemon(true);
      provider.refresh();
      vscode.window.showInformationMessage('xsess 本地服务已重启');
    }),
  );

  context.subscriptions.push({ dispose: killDaemon });
}

function deactivate() {
  killDaemon();
}

// ---------------------------------------------------------------- daemon 连接

function config() {
  return vscode.workspace.getConfiguration('xsess');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_STATE, 'utf8'));
  } catch {
    return null;
  }
}

/** 安装时 xsess CLI 会把自己的绝对路径写进扩展目录的 config.json */
function daemonEntry() {
  const fromSetting = config().get('daemonEntry');
  if (fromSetting) return fromSetting;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return cfg.daemonEntry;
  } catch {
    return null;
  }
}

function port() {
  const state = readState();
  return (state && state.port) || config().get('daemonPort') || 10180;
}

/**
 * 用 node:http 而不是 fetch —— 各家 IDE 内嵌的 Electron 版本跨度很大，
 * 老一点的没有全局 fetch。node:http 从来都在。
 */
function request(pathname, { method = 'GET', token, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path: pathname,
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error(`返回的不是合法 JSON: ${e.message}`));
            }
          } else {
            reject(new Error(`${res.statusCode} ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function daemonAlive() {
  try {
    await request('/api/health', { timeout: 1200 });
    return true;
  } catch {
    return false;
  }
}

/** daemon 没跑就拉起来。用户不该为了看侧边栏先去开个终端。 */
async function ensureDaemon(force = false) {
  if (!force && (await daemonAlive())) return true;
  if (!config().get('autoStartDaemon')) return false;

  const entry = daemonEntry();
  if (!entry || !fs.existsSync(entry)) return false;

  daemonProcess = spawn(process.execPath, [entry, '--port', String(port())], {
    detached: true,
    stdio: 'ignore',
  });
  daemonProcess.unref();

  // 轮询等它起来，最多 5 秒
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await daemonAlive()) return true;
  }
  return false;
}

function killDaemon() {
  if (daemonProcess && !daemonProcess.killed) {
    try {
      process.kill(-daemonProcess.pid);
    } catch {
      try {
        daemonProcess.kill();
      } catch {
        /* 已经没了 */
      }
    }
  }
  daemonProcess = null;
}

async function api(pathname, opts = {}) {
  const state = readState();
  if (!state || !state.token) {
    throw new Error('找不到 ~/.xsess/daemon.json，先在终端跑一次 `xsess scan`');
  }
  return request(pathname, { ...opts, token: state.token });
}

// ---------------------------------------------------------------- 侧边栏

class SessionsViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = renderHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'ready':
          case 'query':
            await this.load(msg.query || {});
            break;
          case 'open':
            await this.openSession(msg.id);
            break;
          case 'handoff':
            await this.handoff(msg.id);
            break;
          case 'rescan':
            await api('/api/scan', { method: 'POST' });
            await this.load(msg.query || {});
            break;
        }
      } catch (e) {
        this.post({ type: 'error', message: String(e.message || e) });
      }
    });

    this.refresh();
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  refresh() {
    this.post({ type: 'refresh' });
  }

  async load(query) {
    this.post({ type: 'loading' });

    if (!(await ensureDaemon())) {
      this.post({
        type: 'error',
        message:
          '本地服务没起来。在终端跑一次 `xsess daemon start`，' +
          '或把 xsess.daemonEntry 指到 bin/xsess-daemon.js。',
      });
      return;
    }

    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.tool) params.set('tool', query.tool);
    if (query.all) params.set('all', '1');
    params.set('limit', '80');

    const wsFilter = query.workspaceOnly ?? config().get('filterByWorkspace');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (wsFilter && folder) params.set('cwd', folder.uri.fsPath);

    const [data, tools] = await Promise.all([
      api(`/api/sessions?${params}`),
      api('/api/tools'),
    ]);

    this.post({
      type: 'sessions',
      sessions: data.sessions,
      tools: tools.tools.filter((t) => t.available),
      unsupported: tools.unsupported,
      workspace: folder ? folder.uri.fsPath : null,
    });
  }

  /** 在编辑器里打开会话全文（只读的 markdown，方便搜索和复制） */
  async openSession(id) {
    const s = await api(`/api/sessions/${encodeURIComponent(id)}?max=500`);
    const lines = [
      `# ${s.title}`,
      '',
      `- 来源：${s.tool}${s.model ? ` · ${s.model}` : ''}`,
      s.cwd ? `- 目录：\`${s.cwd}\`` : null,
      `- 时间：${fmt(s.startedAt)} → ${fmt(s.updatedAt)}`,
      `- ID：\`${s.id}\``,
      '',
      '---',
      '',
    ].filter((x) => x !== null);

    for (const m of s.messages) {
      const who = { user: '你', assistant: 'AI', tool: '工具', system: '系统', unknown: '?' }[m.role] || m.role;
      lines.push(`### ${who}`, '', m.text, '');
    }

    const doc = await vscode.workspace.openTextDocument({
      content: lines.join('\n'),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * 接续到当前 IDE。
   *
   * 这里刻意不去写 Antigravity / Cursor 的会话库 —— 那些是 protobuf 和
   * 运行中的 WAL 数据库，反向写入是在拿用户的历史赌博。
   * 改成：交接包落到工作区文件 + 复制到剪贴板 + 打开它，
   * 你在聊天框粘贴或 @ 引用即可，效果一样是「接着那个会话继续」。
   */
  async handoff(id) {
    const pack = await api(`/api/handoff/${encodeURIComponent(id)}`);
    const folder = vscode.workspace.workspaceFolders?.[0];

    let target = null;
    if (folder) {
      const dir = path.join(folder.uri.fsPath, '.xsess');
      fs.mkdirSync(dir, { recursive: true });
      target = path.join(dir, `handoff-${pack.sessionId.replace(/[^\w.-]/g, '_')}.md`);
      fs.writeFileSync(target, pack.markdown, 'utf8');
    }

    await vscode.env.clipboard.writeText(pack.markdown);

    if (target) {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: false });
    } else {
      const doc = await vscode.workspace.openTextDocument({
        content: pack.markdown,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    const hint = target
      ? `交接包已复制到剪贴板，也存到了 ${path.relative(folder.uri.fsPath, target)}。在聊天框粘贴，或 @ 引用这个文件。`
      : '交接包已复制到剪贴板，直接在聊天框粘贴即可。';
    vscode.window.showInformationMessage(hint);
  }
}

function fmt(iso) {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '?';
}

module.exports = { activate, deactivate };
