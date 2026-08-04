/**
 * xsess Web 管理面板。
 *
 * 单文件、无外部资源（不装依赖、不连 CDN，离线可用）。
 * 由 daemon 在 127.0.0.1 上提供，数据走已有的 /api/*。
 *
 * ── 鉴权 ──
 * API 要 Bearer token。页面壳子本身不需要鉴权（里面没有数据），
 * token 通过 URL **fragment**（`#token=…`）传进来：fragment 不会发给服务端、
 * 不进 referer、不进服务端日志。页面拿到后存进 sessionStorage 并把地址栏擦干净，
 * 之后所有 API 调用带上它。
 * 这样即使你把窗口留着，别的网页也拿不到 token（同源策略挡住 sessionStorage）。
 */

export function renderUi() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>xsess · 共享会话</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --dim: #6b7280; --line: #e5e7eb;
    --hover: #f3f4f6; --sel: #eef2ff; --card: #fafafa;
    --mark: #fde68a; --danger: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181a; --fg: #e5e7eb; --dim: #9ca3af; --line: #2c2e33;
      --hover: #212327; --sel: #1e2537; --card: #1c1e21;
      --mark: #78591c; --danger: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }

  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--line); flex: none;
  }
  .logo { font-weight: 700; letter-spacing: -.02em; }
  .logo span { color: var(--dim); font-weight: 400; margin-left: 8px; font-size: 12px; }
  #q {
    flex: 1; min-width: 0; padding: 7px 11px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    font: inherit;
  }
  #q:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
  button {
    padding: 6px 11px; border-radius: 6px; border: 1px solid var(--line);
    background: var(--card); color: var(--fg); cursor: pointer; font: inherit; font-size: 13px;
    white-space: nowrap;
  }
  button:hover { background: var(--hover); }
  button.primary { background: #4f46e5; color: #fff; border-color: #4f46e5; }
  button.primary:hover { background: #4338ca; }

  main { flex: 1; display: flex; min-height: 0; }
  aside {
    width: 232px; flex: none; border-right: 1px solid var(--line);
    overflow-y: auto; padding: 12px 8px;
  }
  .grp { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
         color: var(--dim); padding: 10px 8px 5px; }
  .f {
    display: flex; align-items: center; gap: 7px; padding: 5px 8px;
    border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .f:hover { background: var(--hover); }
  .f.on { background: var(--sel); font-weight: 600; }
  .f .n { margin-left: auto; color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .f .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }

  #list { width: 400px; flex: none; border-right: 1px solid var(--line); overflow-y: auto; }
  .item { padding: 10px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .item:hover { background: var(--hover); }
  .item.on { background: var(--sel); }
  .t { font-weight: 500; margin-bottom: 3px;
       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag { font-weight: 700; }
  .m { font-size: 11.5px; color: var(--dim);
       overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .snip { font-size: 12px; color: var(--dim); margin-top: 4px;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  mark { background: var(--mark); color: inherit; border-radius: 2px; }

  #detail { flex: 1; overflow-y: auto; padding: 20px 26px; min-width: 0; }
  #detail h2 { margin: 0 0 6px; font-size: 19px; }
  .facts { color: var(--dim); font-size: 12.5px; margin-bottom: 14px; }
  .acts { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 18px; }
  .msg { margin-bottom: 16px; }
  .who { font-size: 11px; font-weight: 700; letter-spacing: .04em;
         text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .msg.tool .body, .msg.system .body {
    color: var(--dim); font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, monospace;
    background: var(--card); padding: 7px 10px; border-radius: 6px;
    max-height: 140px; overflow: auto;
  }
  .empty { color: var(--dim); padding: 40px 20px; text-align: center; line-height: 1.9; }
  .err { color: var(--danger); padding: 20px; white-space: pre-wrap; }
  #bar {
    display: flex; align-items: center; gap: 10px; padding: 8px 16px;
    border-bottom: 1px solid var(--line); font-size: 12.5px; flex: none;
    background: var(--card);
  }
  #bar .sp { flex: 1; }
  #bar .warn { color: #b45309; }
  @media (prefers-color-scheme: dark) { #bar .warn { color: #fbbf24; } }
  .item { display: flex; gap: 9px; align-items: flex-start; }
  .item .cb { margin-top: 3px; flex: none; }
  .item .col { min-width: 0; flex: 1; }
  .badge {
    font-size: 10px; padding: 1px 5px; border-radius: 4px; margin-left: 6px;
    background: #10b98122; color: #059669; border: 1px solid #10b98155;
    white-space: nowrap;
  }
  @media (prefers-color-scheme: dark) { .badge { color: #34d399; } }
  #toast {
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: var(--fg); color: var(--bg); padding: 9px 16px; border-radius: 8px;
    font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none;
  }
  #toast.show { opacity: .95; }
</style>
</head>
<body>
<header>
  <div class="logo">xsess<span id="stat">加载中…</span></div>
  <input id="q" type="search" placeholder="搜索所有工具的会话…（中文可用）">
  <button id="rescan">重新扫描</button>
</header>

<div id="bar">
  <span id="syncState">同步状态加载中…</span>
  <span class="sp"></span>
  <span id="selCount"></span>
  <button id="selAll">全选当前列表</button>
  <button id="btnSync" class="primary">同步选中 → Antigravity</button>
  <button id="btnUnsync">取消同步</button>
</div>

<main>
  <aside>
    <div class="grp">工具</div>
    <div id="tools"></div>
    <div class="grp">项目</div>
    <div id="projects"></div>
    <div class="grp">选项</div>
    <div class="f" id="fSub"><span>包含子代理会话</span></div>
  </aside>
  <div id="list"><div class="empty">加载中…</div></div>
  <div id="detail"><div class="empty">从左边选一个会话</div></div>
</main>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);

// token 从 URL fragment 拿（不发给服务端、不进 referer），存 sessionStorage 后擦掉地址栏
let TOKEN = sessionStorage.getItem('xsess_token') || '';
const frag = new URLSearchParams(location.hash.slice(1));
if (frag.get('token')) {
  TOKEN = frag.get('token');
  sessionStorage.setItem('xsess_token', TOKEN);
  history.replaceState(null, '', location.pathname);
}

const COLORS = {
  'claude-code': '#d97757', codex: '#10a37f', antigravity: '#a78bfa',
  cursor: '#38bdf8', 'gemini-cli': '#4285f4',
};
const NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
  cursor: 'Cursor', 'gemini-cli': 'Gemini CLI',
};

let state = {
  q: '', tool: null, cwd: null, all: false,
  sessions: [], selected: null,
  synced: new Set(),   // 已经出现在 Antigravity 原生会话栏里的
  picked: new Set(),   // 当前勾选待同步的
  agRunning: false,
  orphans: 0,          // 索引里挂着、会话文件已不在的残留条目
};

async function api(p, opts = {}) {
  const r = await fetch(p, {
    ...opts,
    // 合并而不是覆盖：POST 要带 content-type，直接赋值会把它冲掉
    headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + TOKEN },
  });
  if (r.status === 401) throw new Error('token 不对。用 \`xsess ui\` 重新打开这个页面。');
  if (!r.ok) {
    // 服务端把原因写在 error 字段里，直接透出来 ——
    // 只显示 "500" 的话用户根本不知道该做什么
    let msg = r.status + '';
    try { msg = (await r.json()).error || msg; } catch { msg = r.status + ' ' + (await r.text().catch(() => '')); }
    throw new Error(msg);
  }
  return r.json();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function hl(s) { return esc(s).replace(/⟦/g, '<mark>').replace(/⟧/g, '</mark>'); }
function rel(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime(), m = Math.floor(d / 6e4);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60); if (h < 24) return h + ' 小时前';
  const dd = Math.floor(h / 24); if (dd < 30) return dd + ' 天前';
  const mo = Math.floor(dd / 30);
  return mo < 12 ? mo + ' 个月前' : Math.floor(mo / 12) + ' 年前';
}
function shortPath(p) {
  if (!p) return '';
  return p.replace(/^\\/Users\\/[^/]+/, '~');
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

async function loadStats() {
  const s = await api('/api/stats');
  $('stat').textContent = s.totals.sessions + ' 个会话 · ' + s.totals.messages.toLocaleString() + ' 条消息';
  $('tools').innerHTML =
    '<div class="f ' + (state.tool ? '' : 'on') + '" data-tool=""><span>全部</span>' +
    '<span class="n">' + s.totals.sessions + '</span></div>' +
    s.byTool.map((r) =>
      '<div class="f ' + (state.tool === r.tool ? 'on' : '') + '" data-tool="' + esc(r.tool) + '">' +
      '<span class="dot" style="background:' + (COLORS[r.tool] || '#888') + '"></span>' +
      '<span>' + esc(NAMES[r.tool] || r.tool) + '</span>' +
      '<span class="n">' + (r.sessions - (r.subagents || 0)) + '</span></div>').join('');
  bindFilters();
}

async function loadProjects() {
  // 从会话列表里归纳出项目，不额外加接口
  const d = await api('/api/sessions?limit=300');
  const counts = {};
  for (const s of d.sessions) if (s.cwd) counts[s.cwd] = (counts[s.cwd] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14);
  $('projects').innerHTML =
    '<div class="f ' + (state.cwd ? '' : 'on') + '" data-cwd=""><span>全部</span></div>' +
    top.map(([p, n]) =>
      '<div class="f ' + (state.cwd === p ? 'on' : '') + '" data-cwd="' + esc(p) + '" title="' + esc(p) + '">' +
      '<span class="path">' + esc(shortPath(p)) + '</span><span class="n">' + n + '</span></div>').join('');
  bindFilters();
}

function bindFilters() {
  document.querySelectorAll('#tools .f').forEach((el) => {
    el.onclick = () => { state.tool = el.dataset.tool || null; refresh(); };
  });
  document.querySelectorAll('#projects .f').forEach((el) => {
    el.onclick = () => { state.cwd = el.dataset.cwd || null; refresh(); };
  });
  $('fSub').classList.toggle('on', state.all);
  $('fSub').onclick = () => { state.all = !state.all; refresh(); };
}

async function loadList() {
  const p = new URLSearchParams({ limit: '150' });
  if (state.q) p.set('q', state.q);
  if (state.tool) p.set('tool', state.tool);
  if (state.cwd) p.set('cwd', state.cwd);
  if (state.all) p.set('all', '1');
  const d = await api('/api/sessions?' + p);
  state.sessions = d.sessions;

  if (!d.sessions.length) {
    $('list').innerHTML = '<div class="empty">没有匹配的会话</div>';
    return;
  }
  $('list').innerHTML = d.sessions.map((s) => {
    const done = state.synced.has(s.id);
    return '<div class="item' + (state.selected === s.id ? ' on' : '') + '" data-id="' + esc(s.id) + '">' +
      '<input class="cb" type="checkbox"' + (state.picked.has(s.id) ? ' checked' : '') + '>' +
      '<div class="col">' +
        '<div class="t"><span class="tag" style="color:' + (COLORS[s.tool] || '#888') + '">' +
          esc(s.prefix || '··') + '：</span>' + esc(s.title) +
          (done ? '<span class="badge">已在会话栏</span>' : '') + '</div>' +
        '<div class="m">' + [rel(s.updatedAt), s.messageCount + ' 条', s.model, shortPath(s.cwd)]
          .filter(Boolean).map(esc).join(' · ') + '</div>' +
        (s.snippet ? '<div class="snip">' + hl(s.snippet) + '</div>' : '') +
      '</div></div>';
  }).join('');

  document.querySelectorAll('.item').forEach((el) => {
    const id = el.dataset.id;
    const cb = el.querySelector('.cb');
    cb.onclick = (e) => {
      e.stopPropagation();                       // 勾选不该顺带打开会话
      cb.checked ? state.picked.add(id) : state.picked.delete(id);
      renderSelCount();
    };
    el.onclick = () => openSession(id);
  });
  renderSelCount();
}

async function openSession(id) {
  state.selected = id;
  document.querySelectorAll('.item').forEach((e) => e.classList.toggle('on', e.dataset.id === id));
  $('detail').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const s = await api('/api/sessions/' + encodeURIComponent(id) + '?max=400');
    const facts = [NAMES[s.tool] || s.tool, s.model, shortPath(s.cwd), s.gitBranch && ('⎇ ' + s.gitBranch),
                   s.messageCount + ' 条消息', rel(s.updatedAt)].filter(Boolean);
    $('detail').innerHTML =
      '<h2><span class="tag" style="color:' + (COLORS[s.tool] || '#888') + '">' +
        esc(s.prefix || '') + '：</span>' + esc(s.title) + '</h2>' +
      '<div class="facts">' + esc(facts.join(' · ')) + '<br>' + esc(s.id) + '</div>' +
      '<div class="acts">' +
        '<button class="primary" data-act="copy">复制交接包</button>' +
        '<button data-act="to-antigravity">放进 Antigravity 会话栏</button>' +
        '<button data-act="to-claude-code">接力到 Claude Code</button>' +
        '<button data-act="to-codex">接力到 Codex</button>' +
      '</div>' +
      s.messages.map((m) =>
        '<div class="msg ' + esc(m.role) + '">' +
        '<div class="who">' + ({ user: '你', assistant: 'AI', tool: '工具', system: '系统', unknown: '?' }[m.role] || m.role) + '</div>' +
        '<div class="body">' + esc(m.text) + '</div></div>').join('');

    $('detail').querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => doAction(b.dataset.act, id, b);
    });
  } catch (e) {
    $('detail').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  }
}

async function doAction(act, id, btn) {
  btn.disabled = true;
  try {
    if (act === 'copy') {
      const pack = await api('/api/handoff/' + encodeURIComponent(id));
      await navigator.clipboard.writeText(pack.markdown);
      toast('交接包已复制，直接粘进任何 AI 的聊天框');
    } else {
      const tool = act.replace('to-', '');
      const r = await api('/api/handoff/' + encodeURIComponent(id) + '/write?to=' + tool, { method: 'POST' });
      toast('已在 ' + (NAMES[tool] || tool) + ' 里创建会话，跑 ' + r.resumeHint + ' 接着做');
      loadSync(); loadStats(); loadList();
    }
  } catch (e) {
    toast('失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function renderSelCount() {
  $('selCount').textContent = state.picked.size ? '已选 ' + state.picked.size + ' 条' : '';
  const busy = state.agRunning;
  $('btnSync').disabled = busy || !state.picked.size;
  // 孤儿也要能撤 —— 它们的 .db 已经没了，state.synced 里不算数，
  // 但索引条目还挂在人家会话栏上，不给按钮就永远清不掉
  $('btnUnsync').disabled = busy || (!state.synced.size && !state.orphans);
}

async function loadSync() {
  const st = await api('/api/sync');
  state.synced = new Set(st.synced.map((x) => x.sourceSession));
  state.agRunning = st.running;
  state.orphans = st.orphanCount || 0;

  const orphanNote = state.orphans
    ? ' · <span class="warn">' + state.orphans + ' 条残留</span>' +
      '（会话文件已不在，在它列表里点开是空的 —— 用「取消同步」清掉）'
    : '';
  $('syncState').innerHTML = st.running
    ? '<span class="warn">⚠ Antigravity 正在运行 —— 它退出时会覆盖写入的内容，' +
      '请先完全退出（⌘Q）再同步</span>' + orphanNote
    : '已同步 <b>' + st.syncedCount + '</b> 条到 Antigravity 原生会话栏 · 它当前已退出，可以同步' +
      orphanNote;
  renderSelCount();
}

$('selAll').onclick = () => {
  const ids = state.sessions.map((s) => s.id);
  const allPicked = ids.every((i) => state.picked.has(i));
  ids.forEach((i) => (allPicked ? state.picked.delete(i) : state.picked.add(i)));
  loadList();
};

$('btnSync').onclick = async () => {
  const ids = [...state.picked];
  if (!ids.length) return;
  $('btnSync').disabled = true; $('btnSync').textContent = '同步中…';
  try {
    const r = await api('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, to: 'antigravity', write: true }),
    });
    const bits = [r.synced.length + ' 条已写入'];
    if (r.skipped.length) bits.push(r.skipped.length + ' 条已存在');
    if (r.failed.length) bits.push(r.failed.length + ' 条失败');
    toast(bits.join('，') + '。重开 Antigravity 就能看到');
    state.picked.clear();
    await loadSync(); await loadList();
  } catch (e) { toast('同步失败：' + e.message); }
  finally { $('btnSync').disabled = false; $('btnSync').textContent = '同步选中 → Antigravity'; }
};

$('btnUnsync').onclick = async () => {
  const picked = [...state.picked].filter((i) => state.synced.has(i));
  const scope = picked.length ? picked : null;
  const total = state.synced.size + state.orphans;
  const label = picked.length ? ('选中的 ' + picked.length + ' 条') : ('全部 ' + total + ' 条');
  if (!confirm('要把' + label + '从 Antigravity 的会话栏里撤掉吗？只删 xsess 写进去的，不碰你自己的会话。')) return;
  $('btnUnsync').disabled = true;
  try {
    const r = await api('/api/sync', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: scope, to: 'antigravity', write: true }),
    });
    toast('已撤掉 ' + r.removed.length + ' 条');
    state.picked.clear();
    await loadSync(); await loadList();
  } catch (e) { toast('撤销失败：' + e.message); }
  finally { renderSelCount(); }
};

let timer = null;
$('q').oninput = (e) => {
  state.q = e.target.value.trim();
  clearTimeout(timer); timer = setTimeout(loadList, 250);
};
$('rescan').onclick = async () => {
  $('rescan').disabled = true; $('rescan').textContent = '扫描中…';
  try { await api('/api/scan', { method: 'POST' }); await refresh(); toast('扫描完成'); }
  catch (e) { toast('扫描失败：' + e.message); }
  finally { $('rescan').disabled = false; $('rescan').textContent = '重新扫描'; }
};

async function refresh() {
  try { await loadSync(); await Promise.all([loadStats(), loadProjects(), loadList()]); }
  catch (e) { $('list').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
}
refresh();
</script>
</body>
</html>`;
}
