/**
 * 侧边栏 webview 的 HTML。
 *
 * 独立成一个模块，不 require('vscode') —— 这样可以在浏览器里单独预览调样式，
 * 不用每改一次 CSS 就重启一遍 IDE。
 */

function renderHtml() {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: transparent;
    margin: 0; padding: 8px 6px 16px;
  }
  .bar { display: flex; gap: 4px; margin-bottom: 8px; }
  input[type=search] {
    flex: 1; min-width: 0; padding: 4px 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
    font-family: inherit; font-size: inherit;
  }
  button {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-radius: 3px; padding: 3px 7px; cursor: pointer;
    font-family: inherit; font-size: 11px; white-space: nowrap;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .chips { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 8px; }
  .chip {
    padding: 2px 7px; border-radius: 9px; cursor: pointer; font-size: 11px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    opacity: .65;
  }
  .chip.on { opacity: 1; background: var(--vscode-list-activeSelectionBackground);
             color: var(--vscode-list-activeSelectionForeground); }
  .item {
    padding: 6px 6px; border-radius: 4px; cursor: pointer;
    border-left: 2px solid transparent;
    color: var(--vscode-foreground);
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item:hover .actions { opacity: 1; }
  .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 11px; opacity: .6; margin-top: 2px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .snip { font-size: 11px; opacity: .75; margin-top: 3px;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .snip mark { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; }
  .actions { opacity: 0; margin-top: 4px; display: flex; gap: 4px; transition: opacity .1s; }
  /* 前缀跟标题连成一体（cc：标题），颜色由外层 .t-<工具> 给 */
  .tag { font-weight: 700; opacity: .9; }
  /* 只给前缀和左侧色条上色，标题保持正常前景色 ——
     整条染色的话，十几条混排在一起会很花，反而看不出层次 */
  .t-claude-code { border-left-color: #d97757; }
  .t-claude-code .tag { color: #d97757; }
  .t-codex { border-left-color: #10a37f; }
  .t-codex .tag { color: #10a37f; }
  .t-antigravity { border-left-color: #a78bfa; }
  .t-antigravity .tag { color: #a78bfa; }
  .t-cursor { border-left-color: #38bdf8; }
  .t-cursor .tag { color: #38bdf8; }
  .t-gemini-cli { border-left-color: #4285f4; }
  .t-gemini-cli .tag { color: #4285f4; }
  .hint { opacity: .6; font-size: 11px; padding: 12px 6px; line-height: 1.6; }
  .err { color: var(--vscode-errorForeground); font-size: 11px; padding: 10px 6px; line-height: 1.6; }
</style>
</head>
<body>
  <div class="bar">
    <input type="search" id="q" placeholder="搜所有工具的会话…">
    <button id="rescan" title="重新扫描各工具的会话目录">扫描</button>
  </div>
  <div class="chips" id="chips"></div>
  <div id="list"><div class="hint">加载中…</div></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let state = { q: '', tool: null, all: false, workspaceOnly: false };
let timer = null;

const NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  cursor: 'Cursor', 'gemini-cli': 'Gemini CLI'
};
// 标题前缀（cc / cx / ag …）由 daemon 随每条会话下发，这里不再自己维护映射表

function query() { vscode.postMessage({ type: 'query', query: state }); }

$('q').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  clearTimeout(timer);
  timer = setTimeout(query, 250);
});
$('rescan').addEventListener('click', () => vscode.postMessage({ type: 'rescan', query: state }));

function rel(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  const day = Math.floor(h / 24);
  if (day < 30) return day + ' 天前';
  const mo = Math.floor(day / 30);
  return mo < 12 ? mo + ' 个月前' : Math.floor(mo / 12) + ' 年前';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** daemon 用 ⟦⟧ 包裹命中片段（避免和 HTML 冲突），这里转成 <mark> */
function snippet(s) {
  return esc(s).replace(/⟦/g, '<mark>').replace(/⟧/g, '</mark>');
}

function renderChips(tools, unsupported) {
  const chips = [
    '<span class="chip ' + (state.tool ? '' : 'on') + '" data-tool="">全部</span>',
    ...tools.map((t) =>
      '<span class="chip ' + (state.tool === t.tool ? 'on' : '') + '" data-tool="' + t.tool + '">' +
      esc(NAMES[t.tool] || t.tool) + '</span>'),
    '<span class="chip ' + (state.all ? 'on' : '') + '" data-flag="all" title="包含子代理/后台会话">子代理</span>',
    '<span class="chip ' + (state.workspaceOnly ? 'on' : '') + '" data-flag="ws" title="只看当前工作区目录下的会话">本项目</span>',
  ].join('');
  $('chips').innerHTML = chips;

  for (const el of document.querySelectorAll('.chip')) {
    el.addEventListener('click', () => {
      if (el.dataset.flag === 'all') state.all = !state.all;
      else if (el.dataset.flag === 'ws') state.workspaceOnly = !state.workspaceOnly;
      else state.tool = el.dataset.tool || null;
      query();
    });
  }
}

function renderList(sessions) {
  if (!sessions.length) {
    $('list').innerHTML = '<div class="hint">没有匹配的会话。<br>换个词，或者点上面的「扫描」重新索引。</div>';
    return;
  }
  $('list').innerHTML = sessions.map((s) => {
    const meta = [rel(s.updatedAt), s.messageCount + ' 条', s.model, s.cwd]
      .filter(Boolean).map(esc).join(' · ');
    return '<div class="item t-' + esc(s.tool) + '" data-id="' + esc(s.id) + '">' +
      '<div class="title"><span class="tag">' + esc(s.prefix || '··') + '：</span>' + esc(s.title) + '</div>' +
      '<div class="meta">' + meta + '</div>' +
      (s.snippet ? '<div class="snip">' + snippet(s.snippet) + '</div>' : '') +
      '<div class="actions">' +
        '<button data-act="open">查看全文</button>' +
        '<button data-act="handoff">接续到这里</button>' +
      '</div>' +
    '</div>';
  }).join('');

  for (const el of document.querySelectorAll('.item')) {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'handoff') { e.stopPropagation(); vscode.postMessage({ type: 'handoff', id }); }
      else { vscode.postMessage({ type: 'open', id }); }
    });
  }
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'loading') {
    if (!document.querySelector('.item')) $('list').innerHTML = '<div class="hint">加载中…</div>';
  } else if (m.type === 'sessions') {
    renderChips(m.tools, m.unsupported);
    renderList(m.sessions);
  } else if (m.type === 'error') {
    $('list').innerHTML = '<div class="err">' + esc(m.message) + '</div>';
  } else if (m.type === 'refresh') {
    query();
  }
});

vscode.postMessage({ type: 'ready', query: state });
</script>
</body>
</html>`;
}


module.exports = { renderHtml };
