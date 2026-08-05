/**
 * xsess CLI —— 跨工具会话的命令行入口。
 *
 * 设计成「任何 agent 都能用 Bash 调起来」：默认输出给人看，
 * 加 `--json` 就是给程序看的。M4 的 MCP server 复用的是同一层 core，不是包装这个 CLI。
 */

import process from 'node:process';
import { statSync as fsStatSync } from 'node:fs';
import { openIndex } from '../core/index-db.js';
import { scan } from '../core/scanner.js';
import { ADAPTERS, UNSUPPORTED, toolNames } from '../core/adapters/index.js';
import { ensureXsessDirs, INDEX_DB, TOOLS, exists } from '../core/paths.js';
import * as mcpInstall from '../mcp/install.js';
import { buildHandoff, writeHandoffFile } from '../core/handoff.js';
import { loadState, DEFAULT_PORT } from '../daemon/server.js';
import * as launchd from '../daemon/launchd.js';
import {
  c,
  toolTag,
  toolName,
  relTime,
  padEnd,
  truncWidth,
  humanCount,
  shortPath,
  displayWidth,
  prefixedTitle,
  PREFIX_WIDTH,
} from './fmt.js';

const HELP = `${c.bold('xsess')} —— 跨 AI IDE 的共享会话栏

${c.bold('用法')}
  xsess scan [--force] [--tool <名>]      扫描并建立索引（增量，没变的源直接跳过）
  xsess list [选项]                        按时间倒序列出所有工具的会话
  xsess search <关键词> [选项]             全文搜索（中文可用，trigram 分词）
  xsess show <ID|前缀> [--full] [--json]   看某个会话的完整内容
  xsess stats                              各工具的会话/消息统计
  xsess doctor                             检查各工具存储位置与解析失败的源
  xsess compact                            压缩索引库（大批会话被删后跑一次）

${c.bold('接力')}
  xsess handoff <ID> [--to <工具>]         把某个会话压成交接包，喂给另一个工具继续做
                                           --to claude-code|codex|antigravity 生成真的新会话文件
                                           写 antigravity 需要先完全退出它（会出现在它原生的会话列表里）
                                           不给 --to 就只打印/落盘，供你粘贴或 @ 引用
  xsess undo [--tool <名>] [--write]       删掉 xsess 创建过的会话文件（只删自己写的）

放进别家工具原生的会话栏（--to codex|antigravity|claude-code，默认 antigravity）
  xsess sync [--to <工具>]                 看状态：已同步几条、有没有残骸、它是否在跑
  xsess sync check <ID> [--to <工具>]      演练一遍（不碰目标的文件，它开着也能跑）
  xsess sync add <ID…> [--to <工具>] [--write]      放进它的会话列表
  xsess sync remove [<ID…>|--all|--orphans] [--write] 撤回，连索引记录一起摘掉
                                           --orphans 只清残骸（索引里挂着、文件已不在的）
                                           写 Antigravity 前必须完全退出它（⌘Q）——
                                           它把会话列表缓存在内存里，退出时会覆盖；
                                           Codex 不用退，但侧边栏要重启才刷新

${c.bold('Web 管理面板')}
  xsess ui                                 打开浏览器里的管理面板（会自动拉起 daemon）
                                           搜索 / 按工具和项目筛选 / 看全文 / 一键接力

${c.bold('打通各家 IDE')}
  xsess mcp status | install | uninstall   注册 MCP 服务，让 Claude Code / Codex 自己查别家会话
                                           默认只预览，加 --write 才真正改配置（会先备份）
  xsess daemon start | status              本地 HTTP 服务，VS Code 扩展侧边栏的数据源
  xsess daemon install | uninstall         用 launchd 配置开机自启
  xsess ide status | install | uninstall   把侧边栏扩展装进 Antigravity / Cursor / Trae / Kiro / VS Code

${c.bold('通用选项')}
  --tool <名>      只看某个工具：${toolNames().join(' / ')}
  -n, --limit <N>  条数上限（list 默认 30，search 默认 20）
  --cwd [路径]     只看某个项目目录的会话（不给值就用当前目录）
  --all            包含子代理/后台会话（默认折叠，Codex 那些 guardian 判定会话就是它）
  --json           输出 JSON，给脚本和 agent 用

${c.bold('例子')}
  xsess scan                               第一次用先跑这个
  xsess list --tool codex -n 10
  xsess search "上次那个方案"
  xsess list --cwd                         只看当前项目在各家工具里的会话
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case 'scan':
      return cmdScan(args);
    case 'list':
    case 'ls':
      return cmdList(args);
    case 'search':
    case 's':
      return cmdSearch(args);
    case 'show':
    case 'cat':
      return cmdShow(args);
    case 'stats':
      return cmdStats(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'compact':
      return cmdCompact(args);
    case 'handoff':
      return cmdHandoff(args);
    case 'undo':
      return cmdUndo(args);
    case 'sync':
      return cmdSync(args);
    case 'mcp':
      return cmdMcp(args);
    case 'daemon':
      return cmdDaemon(args);
    case 'ide':
      return cmdIde(args);
    case 'ui':
      return cmdUi(args);
    default:
      process.stderr.write(c.red(`未知命令: ${cmd}\n\n`) + HELP);
      return 1;
  }
}

// ---------------------------------------------------------------- scan

async function cmdScan(args) {
  ensureXsessDirs();
  const index = openIndex();
  const tty = process.stdout.isTTY && !args.json;
  let lastLine = '';

  const report = await scan(index, {
    tools: args.tool ? [args.tool] : undefined,
    force: !!args.force,
    onProgress: (e) => {
      if (!tty) return;
      if (e.phase === 'discovered') {
        lastLine = `  ${toolTag(e.tool)} 发现 ${e.count} 个源`;
        process.stdout.write(`\r${padEnd(lastLine, 78)}`);
      } else if (e.phase === 'parsed') {
        lastLine = `  ${toolTag(e.tool)} 解析 ${e.done}/${e.total}`;
        process.stdout.write(`\r${padEnd(lastLine, 78)}`);
      }
    },
  });

  if (tty) process.stdout.write('\r' + ' '.repeat(78) + '\r');

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    index.close();
    return 0;
  }

  process.stdout.write(c.bold('扫描完成') + c.gray(` (${report.durationMs}ms)\n`));
  for (const [tool, t] of Object.entries(report.tools)) {
    if (t.unavailable) {
      process.stdout.write(`  ${toolTag(tool)} ${c.gray('本机未找到数据，跳过')}\n`);
      continue;
    }
    const parts = [`${t.sessions} 个会话`];
    if (t.skipped) parts.push(c.gray(`${t.skipped} 未变`));
    if (t.pruned) parts.push(c.yellow(`${t.pruned} 已删`));
    if (t.failed) parts.push(c.red(`${t.failed} 失败`));
    process.stdout.write(`  ${toolTag(tool)} ${padEnd(toolName(tool), 14)} ${parts.join(c.gray(' · '))}\n`);
    for (const err of t.errors || []) process.stdout.write(c.red(`      ${err}\n`));
  }
  const s = index.stats();
  process.stdout.write(
    c.gray(`\n索引共 ${s.totals.sessions} 个会话 / ${humanCount(s.totals.messages)} 条消息 → ${shortPath(INDEX_DB)}\n`),
  );
  index.close();
  return 0;
}

// ---------------------------------------------------------------- list

async function cmdList(args) {
  const index = openIndexOrHint();
  if (!index) return 1;

  const rows = index.listSessions({
    tool: args.tool,
    cwd: resolveCwdFilter(args),
    limit: args.limit || 30,
    includeSubagents: !!args.all,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    index.close();
    return 0;
  }

  if (!rows.length) {
    process.stdout.write(c.gray('没有会话。先跑 `xsess scan`，或放宽 --tool / --cwd 过滤。\n'));
    index.close();
    return 0;
  }

  printSessionTable(rows);
  index.close();
  return 0;
}

// ---------------------------------------------------------------- search

async function cmdSearch(args) {
  const q = args._.slice(1).join(' ');
  if (!q) {
    process.stderr.write(c.red('要搜什么？用法：xsess search <关键词>\n'));
    return 1;
  }
  const index = openIndexOrHint();
  if (!index) return 1;

  const rows = index.searchSessions(q, {
    tool: args.tool,
    limit: args.limit || 20,
    includeSubagents: !!args.all,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    index.close();
    return 0;
  }

  if (!rows.length) {
    process.stdout.write(c.gray(`没有匹配「${q}」的会话。`));
    if (!args.all) process.stdout.write(c.gray(' 试试加 --all 把子代理会话也搜进来。'));
    process.stdout.write('\n');
    index.close();
    return 0;
  }

  process.stdout.write(c.gray(`「${q}」命中 ${rows.length} 个会话\n\n`));
  printSessionTable(rows, { snippet: true });
  index.close();
  return 0;
}

// ---------------------------------------------------------------- show

async function cmdShow(args) {
  const key = args._[1];
  if (!key) {
    process.stderr.write(c.red('要看哪个？用法：xsess show <ID 或前缀>\n'));
    return 1;
  }
  const index = openIndexOrHint();
  if (!index) return 1;

  let id;
  try {
    id = index.resolveId(key);
  } catch (e) {
    process.stderr.write(c.red(e.message + '\n'));
    for (const cand of e.candidates || []) process.stderr.write(c.gray(`  ${cand}\n`));
    index.close();
    return 1;
  }
  if (!id) {
    process.stderr.write(c.red(`找不到会话：${key}\n`));
    index.close();
    return 1;
  }

  const s = index.getSession(id);
  if (args.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    index.close();
    return 0;
  }

  process.stdout.write(`${c.bold(prefixedTitle(s.tool, s.title))}\n`);
  const facts = [
    `${toolName(s.tool)}`,
    s.model || null,
    s.cwd ? shortPath(s.cwd) : null,
    s.gitBranch ? `⎇ ${s.gitBranch}` : null,
    `${s.messageCount} 条消息`,
    relTime(s.updatedAt),
  ].filter(Boolean);
  process.stdout.write(c.gray(facts.join(' · ') + '\n'));
  process.stdout.write(c.gray(`${s.id}\n${shortPath(s.path)}\n\n`));

  const limit = args.full ? Infinity : 40;
  const msgs = s.messages.filter((m) => args.full || m.role === 'user' || m.role === 'assistant');
  const shown = msgs.slice(0, limit);

  for (const m of shown) {
    const badge =
      m.role === 'user'
        ? c.cyan('▍你')
        : m.role === 'assistant'
          ? c.green('▍AI')
          : m.role === 'tool'
            ? c.gray('▍工具')
            : c.gray('▍系统');
    process.stdout.write(`${badge} ${c.gray(relTime(m.ts))}\n`);
    const body = args.full ? m.text : truncLines(m.text, 12);
    process.stdout.write(indent(body) + '\n\n');
  }
  if (msgs.length > shown.length) {
    process.stdout.write(c.gray(`… 还有 ${msgs.length - shown.length} 条，加 --full 看全部\n`));
  }
  index.close();
  return 0;
}

// ---------------------------------------------------------------- stats

async function cmdStats(args) {
  const index = openIndexOrHint();
  if (!index) return 1;
  const s = index.stats();

  if (args.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    index.close();
    return 0;
  }

  const nameW = Math.max(...s.byTool.map((r) => displayWidth(toolName(r.tool))), 8);
  const subW = Math.max(...s.byTool.map((r) => (r.subagents ? String(r.subagents).length + 5 : 0)), 0);
  process.stdout.write(
    c.gray(
      `   ${padEnd('工具', nameW)} ${padEnd('会话', 6 + subW)} ${padEnd('消息', 8)} ${padEnd('字数', 8)}最近\n`,
    ),
  );
  for (const r of s.byTool) {
    const sub = r.subagents ? c.gray(` +${r.subagents}子`) : '';
    process.stdout.write(
      `${toolTag(r.tool)} ${padEnd(toolName(r.tool), nameW)} ` +
        `${padEnd(String(Number(r.sessions) - Number(r.subagents || 0)) + sub, 6 + subW)} ` +
        `${padEnd(humanCount(r.messages), 8)} ${padEnd(humanCount(r.chars), 8)}${c.gray(relTime(r.latest))}\n`,
    );
  }
  process.stdout.write(
    c.bold(`\n合计 ${s.totals.sessions} 个会话 / ${humanCount(s.totals.messages)} 条消息\n`),
  );
  if (s.failed.length) {
    process.stdout.write(c.red(`\n${s.failed.length} 个源解析失败，跑 \`xsess doctor\` 看详情\n`));
  }
  index.close();
  return 0;
}

// ---------------------------------------------------------------- compact

/**
 * VACUUM 索引库。
 *
 * 反复扫描 + 清理消失的源会在库里留下空闲页。平时不用管，
 * 但大批会话被删掉之后跑一次能把空间还回去。
 */
async function cmdCompact(args) {
  if (!exists(INDEX_DB)) {
    process.stderr.write(c.yellow('索引还没建。先跑 `xsess scan`\n'));
    return 1;
  }
  const before = statSize(INDEX_DB);
  const index = openIndex();
  const pages = index.db.prepare('PRAGMA freelist_count').get();
  index.db.exec('VACUUM');
  index.close();
  const after = statSize(INDEX_DB);

  process.stdout.write(
    `${c.green('✓')} 索引已压缩 ${mb(before)} → ${mb(after)}` +
      c.gray(` (回收 ${Number(pages.freelist_count)} 个空闲页)\n`),
  );
  if (before - after < before * 0.05) {
    process.stdout.write(
      c.gray('体积基本没变说明库里没什么空洞 —— 现在的大小就是真实数据量\n') +
        c.gray('（trigram 全文索引对每个三字窗口建索引，膨胀是它换来中文子串搜索的代价）\n'),
    );
  }
  return 0;
}

function statSize(p) {
  try {
    return fsStatSync(p).size;
  } catch {
    return 0;
  }
}

function mb(n) {
  return `${(n / 1e6).toFixed(0)}MB`;
}

// ---------------------------------------------------------------- doctor

async function cmdDoctor(args) {
  const out = { paths: [], adapters: [], failed: [] };

  process.stdout.write(c.bold('存储位置\n'));
  for (const [tool, cfg] of Object.entries(TOOLS)) {
    for (const [k, p] of Object.entries(cfg)) {
      if (k === 'displayName') continue;
      const ok = exists(p);
      out.paths.push({ tool, key: k, path: p, exists: ok });
      process.stdout.write(
        `  ${ok ? c.green('✓') : c.gray('·')} ${toolTag(tool)} ${padEnd(k, 14)} ${c.gray(shortPath(p))}\n`,
      );
    }
  }

  process.stdout.write(c.bold('\n适配器\n'));
  for (const a of ADAPTERS) {
    const ok = a.available();
    let count = 0;
    if (ok) {
      try {
        count = (await a.discover()).length;
      } catch (e) {
        process.stdout.write(`  ${c.red('✗')} ${toolTag(a.tool)} discover 失败: ${e.message}\n`);
        continue;
      }
    }
    out.adapters.push({ tool: a.tool, available: ok, sources: count });
    process.stdout.write(
      `  ${ok ? c.green('✓') : c.gray('·')} ${toolTag(a.tool)} ${padEnd(a.displayName, 14)} ` +
        `${ok ? `${count} 个源` : c.gray('无数据')}\n`,
    );
  }

  if (UNSUPPORTED.length) {
    process.stdout.write(c.bold('\n暂不支持\n'));
    for (const u of UNSUPPORTED) {
      out.unsupported = out.unsupported || [];
      out.unsupported.push(u);
      process.stdout.write(`  ${c.gray('·')} ${toolTag(u.tool)} ${padEnd(u.displayName, 14)} ${c.gray(u.reason)}\n`);
    }
  }

  if (exists(INDEX_DB)) {
    const index = openIndex();
    const s = index.stats();
    out.failed = s.failed;
    if (s.failed.length) {
      process.stdout.write(c.bold(c.red(`\n解析失败的源 (${s.failed.length})\n`)));
      for (const f of s.failed.slice(0, 20)) {
        process.stdout.write(`  ${toolTag(f.tool)} ${c.gray(shortPath(f.path))}\n      ${c.red(f.error)}\n`);
      }
    } else {
      process.stdout.write(c.green('\n索引里没有失败的源\n'));
    }
    index.close();
  } else {
    process.stdout.write(c.gray('\n索引还没建，先跑 `xsess scan`\n'));
  }

  if (args.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

// ---------------------------------------------------------------- handoff

async function cmdHandoff(args) {
  const key = args._[1];
  if (!key) {
    process.stderr.write(c.red('要接哪个会话？用法：xsess handoff <ID> [--to claude-code|codex]\n'));
    return 1;
  }

  const pack = await buildHandoff(key, { maxTurns: args.turns ? parseInt(args.turns, 10) : 12 });
  if (!pack) {
    process.stderr.write(c.red(`找不到会话：${key}\n`));
    return 1;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(pack, null, 2) + '\n');
    return 0;
  }

  // 不指定目标就只输出交接包本身，供你粘贴或让 IDE @ 引用
  if (!args.to) {
    const file = writeHandoffFile(pack);
    process.stdout.write(pack.markdown + '\n');
    process.stderr.write(c.gray(`\n已落盘 → ${shortPath(file)}\n`));
    return 0;
  }

  const { writeSession, TIER_A } = await import('../core/writers/index.js');
  if (!TIER_A.includes(args.to)) {
    process.stderr.write(
      c.red(`--to 只支持真能写回的工具：${TIER_A.join(' / ')}\n`) +
        c.gray('Cursor 的 state.vscdb 动辄几百 MB、运行时开着 WAL 在写，直写等于拿全部历史赌一把；\n') +
        c.gray('它走「注入式接力」——用不带 --to 的形式生成交接包，在 IDE 里 @ 引用那个文件。\n'),
    );
    return 1;
  }

  const result = await writeSession(args.to, pack, {
    write: !!args.write,
    allowWhileRunning: !!args.allowWhileRunning,
  });
  if (!args.write) {
    process.stdout.write(c.yellow('预览（未写入）\n'));
    process.stdout.write(`  目标工具: ${toolName(args.to)}\n`);
    process.stdout.write(`  将创建:   ${shortPath(result.path)}\n`);
    process.stdout.write(`  内容:     ${result.messageCount} 条消息，标题「${result.title}」\n`);
    process.stdout.write(c.gray(`\n确认无误后加 --write 执行。只新增文件，不会改动任何已有会话。\n`));
    return 0;
  }

  process.stdout.write(c.green('✓ ') + `已在 ${toolName(args.to)} 里创建会话\n`);
  process.stdout.write(`  ${shortPath(result.path)}\n\n`);
  process.stdout.write(c.gray(`现在去终端跑 ${result.resumeHint} 就能接着做。\n`));
  return 0;
}

// ---------------------------------------------------------------- undo

async function cmdUndo(args) {
  const { listWrites, revertWrites, MANIFEST_PATH } = await import('../core/writers/index.js');
  const all = listWrites();

  if (!all.length) {
    process.stdout.write(c.gray('xsess 还没往任何工具里写过会话。\n'));
    return 0;
  }

  // 可以只撤某个工具的，或只撤最近 N 条
  const filter = args.tool ? (e) => e.tool === args.tool : undefined;
  const results = revertWrites({ write: !!args.write, filter });

  for (const r of results) {
    const mark = r.removed ? c.green('✓ 已删') : r.exists ? c.yellow('将删') : c.gray('已不在');
    process.stdout.write(`  ${mark} ${toolTag(r.tool)} ${c.gray(shortPath(r.path))}\n`);
    process.stdout.write(c.gray(`        来自 ${r.sourceSession} · ${r.createdAt.slice(0, 16).replace('T', ' ')}\n`));
  }

  if (!args.write) {
    process.stdout.write(c.yellow(`\n这是预览。加 --write 才真的删除。\n`));
    process.stdout.write(c.gray(`只删 xsess 自己创建过的文件（记在 ${shortPath(MANIFEST_PATH)}），绝不碰别的。\n`));
  }
  return 0;
}

// ---------------------------------------------------------------- sync

/**
 * 让别家工具的会话出现在 Antigravity **原生的**会话栏里。
 *
 * 和 handoff --to antigravity 的区别：这个管的是「哪些会话常驻在那边」，
 * 记账、去重、撤回、孤儿清理都在这一层。
 */
async function cmdSync(args) {
  const S = await import('../core/sync.js');
  const to = args.to || 'antigravity';
  const sub = args._[1];

  // xsess sync check <ID> —— 演练，不碰目标工具的任何文件，它开着也能验。
  // Antigravity 会真的把会话库生成到临时目录跑完整结构自检（它的格式风险最高）；
  // 其余工具走预览，报出将要创建什么。
  if (sub === 'check') {
    const key = args._[2];
    if (!key) {
      process.stderr.write(c.red('要验哪个会话？用法：xsess sync check <ID> [--to <工具>]\n'));
      return 1;
    }
    const pack = await buildHandoff(key);
    if (!pack) {
      process.stderr.write(c.red(`找不到会话：${key}\n`));
      return 1;
    }

    if (to === 'antigravity') {
      const os = await import('node:os');
      const fsp = await import('node:fs');
      const pathp = await import('node:path');
      const { writeAntigravitySession } = await import('../core/writers/antigravity.js');
      const dir = fsp.mkdtempSync(pathp.join(os.tmpdir(), 'xsess-check-'));
      try {
        const r = writeAntigravitySession(pack, { previewDir: dir });
        const size = (fsp.statSync(r.path).size / 1024) | 0;
        process.stdout.write(c.green('✓ ') + '结构自检通过\n');
        process.stdout.write(`  标题:   ${r.title}\n`);
        process.stdout.write(`  内容:   ${r.messageCount} 条消息，生成 ${size}KB\n`);
        process.stdout.write(`  模板:   ${r.templateFrom}\n`);
        process.stdout.write(`  工作区: ${r.templateWorkspace || '(未匹配)'}\n`);
      } finally {
        fsp.rmSync(dir, { recursive: true, force: true });
      }
    } else {
      const { writeSession } = await import('../core/writers/index.js');
      const r = await writeSession(to, pack, { write: false });
      process.stdout.write(c.green('✓ ') + '可以写入\n');
      process.stdout.write(`  标题:   ${r.title}\n`);
      process.stdout.write(`  内容:   ${r.messageCount} 条消息\n`);
      process.stdout.write(`  将创建: ${shortPath(r.path)}\n`);
    }
    process.stdout.write(
      c.gray(`\n演练不碰 ${toolName(to)} 的任何文件。真写用 xsess sync add <ID> --to ${to} --write\n`),
    );
    return 0;
  }

  // xsess sync remove [<ID>…] [--all]
  if (sub === 'remove' || sub === 'rm') {
    const ids = args._.slice(2);
    if (!ids.length && !args.all && !args.orphans) {
      process.stderr.write(
        c.red('要撤哪些？给会话 ID，或用 --all 全撤，或用 --orphans 只清残骸。\n'),
      );
      return 1;
    }
    const r = await S.unsync(ids.length ? ids : null, {
      to,
      write: !!args.write,
      orphansOnly: !!args.orphans,
    });
    if (!r.removed.length) {
      process.stdout.write(c.gray('没有可撤的记录。\n'));
      return 0;
    }
    for (const x of r.removed) {
      const tag = x.orphan ? c.yellow('孤儿') : c.gray('会话');
      process.stdout.write(`  ${args.write ? c.green('✓ 已撤') : c.yellow('将撤')} ${tag} ${x.targetId.slice(0, 8)} ${c.gray('← ' + x.sourceSession)}\n`);
    }
    // 只有 Antigravity 需要重拼它的会话列表，才有「保留/摘掉多少条」这个概念
    if (r.droppedRecords || r.keptRecords) {
      process.stdout.write(`\n  会话列表: 保留 ${r.keptRecords} 条 / 摘掉 ${r.droppedRecords} 条\n`);
    }
    if (!args.write) process.stdout.write(c.yellow('\n这是预览。加 --write 才真的撤。\n'));
    return 0;
  }

  // xsess sync add <ID…>
  if (sub === 'add') {
    const ids = args._.slice(2);
    if (!ids.length) {
      process.stderr.write(c.red('要同步哪些会话？用法：xsess sync add <ID…> [--write]\n'));
      return 1;
    }
    // ID 允许写前缀，这里先解析成完整 ID
    const resolved = [];
    for (const key of ids) {
      const pack = await buildHandoff(key);
      if (!pack) {
        process.stderr.write(c.red(`找不到会话：${key}\n`));
        return 1;
      }
      resolved.push(pack.sessionId);
    }
    const r = await S.syncMany(resolved, { to, write: !!args.write });
    for (const x of r.synced) {
      process.stdout.write(`  ${args.write ? c.green('✓') : c.yellow('将写')} ${x.title}\n`);
    }
    for (const x of r.skipped) process.stdout.write(`  ${c.gray('跳过')} ${x.id} —— ${x.reason}\n`);
    for (const x of r.failed) process.stdout.write(`  ${c.red('✗')} ${x.id} —— ${x.error}\n`);
    if (!args.write && r.synced.length) {
      process.stdout.write(c.yellow('\n这是预览。加 --write 才真的写入。\n'));
      if (to === 'antigravity') {
        process.stdout.write(
          c.gray('注意：Antigravity 必须完全退出（⌘Q），否则它退出时会用内存里的列表覆盖掉。\n'),
        );
      }
    } else if (args.write && r.synced.length) {
      process.stdout.write(c.gray('\n' + S.afterSyncHint(to) + '\n'));
    }
    return r.failed.length ? 1 : 0;
  }

  // 不带子命令 = 看状态
  const st = await S.syncStatus({ to });
  process.stdout.write(`目标: ${toolName(to)}${c.gray('（--to 可选：' + st.targets.join(' / ') + '）')}\n`);
  if (S.targetRunning(to) || to === 'antigravity') {
    process.stdout.write(
      `  正在运行: ${st.running ? c.yellow('是 —— 写入前必须完全退出（⌘Q）') : c.green('否，可以写入')}\n`,
    );
  }
  process.stdout.write(`  已同步:   ${st.syncedCount} 条\n`);
  for (const s of st.synced) {
    process.stdout.write(c.gray(`    ${s.targetId.slice(0, 8)} ← ${s.sourceSession}\n`));
  }
  if (st.orphanCount) {
    process.stdout.write(
      c.yellow(`  孤儿:     ${st.orphanCount} 条`) +
        c.gray('（索引里挂着、会话文件已不在 —— 在对方列表里点开是空的）\n'),
    );
    for (const o of st.orphans) {
      process.stdout.write(c.gray(`    ${o.targetId.slice(0, 8)} ← ${o.sourceSession}\n`));
    }
    process.stdout.write(
      c.gray(`  清掉它们：xsess sync remove --orphans --to ${to} --write\n`),
    );
  }
  const suffix = to === 'antigravity' ? '' : ` --to ${to}`;
  process.stdout.write(
    c.gray(`\n  xsess sync check <ID>${suffix}${' '.repeat(Math.max(1, 10 - suffix.length))}演练一遍，不碰 ${toolName(to)} 的文件\n`) +
      c.gray(`  xsess sync add <ID…>${suffix} --write   放进它的原生会话栏\n`),
  );
  if (st.hint) process.stdout.write(c.gray(`  ${st.hint}\n`));
  return 0;
}

// ---------------------------------------------------------------- mcp

async function cmdMcp(args) {
  const sub = args._[1] || 'status';
  const tools = args.tool ? [args.tool] : ['claude-code', 'codex'];

  if (sub === 'status') {
    for (const s of mcpInstall.status()) {
      process.stdout.write(
        `  ${s.installed ? c.green('✓') : c.gray('·')} ${toolTag(s.tool)} ${padEnd(toolName(s.tool), 14)} ${c.gray(s.detail)}\n`,
      );
    }
    process.stdout.write(c.gray(`\nMCP 入口: ${shortPath(mcpInstall.MCP_ENTRY)}\n`));
    return 0;
  }

  if (sub === 'install' || sub === 'uninstall') {
    const fn = sub === 'install' ? mcpInstall.install : mcpInstall.uninstall;
    const results = fn({ tools, write: !!args.write });
    for (const r of results) {
      const mark =
        r.action === 'added' || r.action === 'removed'
          ? c.green('✓')
          : r.action === 'error'
            ? c.red('✗')
            : c.gray('·');
      process.stdout.write(`  ${mark} ${toolTag(r.tool)} ${padEnd(r.action, 12)} ${c.gray(r.detail)}\n`);
      if (r.preview && !args.write) {
        process.stdout.write(indent(c.gray(r.preview), '      ') + '\n');
      }
    }
    if (!args.write) {
      process.stdout.write(
        c.yellow(`\n这是预览。加 --write 才会真的改配置（改前自动备份到 ~/.xsess/backups/）。\n`),
      );
    } else if (sub === 'install') {
      process.stdout.write(c.gray('\n重启 Claude Code / Codex 后生效。\n'));
    }
    return 0;
  }

  process.stderr.write(c.red(`未知子命令: ${sub}（可用 status / install / uninstall）\n`));
  return 1;
}

// ---------------------------------------------------------------- ui

/**
 * 打开 Web 管理面板。
 *
 * token 走 URL 的 fragment（`#token=…`）而不是查询串：
 * fragment 不会发给服务端、不进 referer、不进任何服务端日志。
 * 页面拿到后存进 sessionStorage 并把地址栏擦干净。
 */
async function cmdUi(args) {
  const { startDaemon } = await import('../daemon/server.js');
  const state = loadState();
  const port = args.port ? parseInt(args.port, 10) : state.port || DEFAULT_PORT;

  let alive = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    alive = r.ok;
  } catch {
    /* 没起来，下面拉起 */
  }

  if (!alive) {
    startDaemon({ port });
    process.stdout.write(c.gray(`daemon 已启动 :${port}\n`));
  }

  const url = `http://127.0.0.1:${port}/#token=${state.token}`;
  process.stdout.write(c.bold('xsess 管理面板\n') + `  ${url}\n\n`);

  if (!args.noOpen) {
    try {
      const { execFile } = await import('node:child_process');
      execFile('open', [url]);
      process.stdout.write(c.gray('已在浏览器打开\n'));
    } catch {
      process.stdout.write(c.gray('自动打开失败，手动复制上面的地址\n'));
    }
  }

  if (!alive) {
    process.stdout.write(c.gray('\nCtrl-C 退出 daemon（面板会跟着失效）\n'));
    return new Promise(() => {}); // 前台常驻，别让 daemon 跟着进程一起死
  }
  return 0;
}

// ---------------------------------------------------------------- ide

const IDE_LABEL = {
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  'trae-cn': 'Trae CN',
  kiro: 'Kiro',
  vscode: 'VS Code',
};

async function cmdIde(args) {
  const ide = await import('../ide/install.js');
  const sub = args._[1] || 'status';
  const ides = args.ide ? [args.ide] : undefined;

  if (sub === 'status') {
    for (const t of ide.status()) {
      const mark = !t.present ? c.gray('·') : t.installed ? c.green('✓') : c.yellow('○');
      const note = !t.present ? '未安装该 IDE' : t.installed ? '已装侧边栏' : '未装侧边栏';
      process.stdout.write(`  ${mark} ${padEnd(IDE_LABEL[t.ide] || t.ide, 14)} ${c.gray(note)}  ${c.gray(shortPath(t.dir))}\n`);
    }
    process.stdout.write(c.gray(`\n扩展源码: ${shortPath(ide.EXT_SRC)}\n`));
    return 0;
  }

  if (sub === 'install' || sub === 'uninstall') {
    const results =
      sub === 'install' ? ide.install({ ides, write: !!args.write }) : ide.uninstall({ ides, write: !!args.write });
    if (!results.length) {
      process.stdout.write(c.gray('没有找到可安装的 IDE。\n'));
      return 0;
    }
    for (const r of results) {
      const mark = /added|updated|removed/.test(r.action)
        ? c.green('✓')
        : r.action === 'error'
          ? c.red('✗')
          : c.gray('·');
      process.stdout.write(
        `  ${mark} ${padEnd(IDE_LABEL[r.ide] || r.ide, 14)} ${padEnd(r.action, 14)} ${c.gray(shortPath(r.detail))}\n`,
      );
      if (r.manifest && r.manifest !== 'ok') {
        process.stdout.write(c.gray(`      extensions.json: ${r.manifest}\n`));
      }
    }
    if (!args.write) {
      process.stdout.write(c.yellow('\n这是预览。加 --write 才会真的拷贝安装。\n'));
    } else if (sub === 'install') {
      process.stdout.write(
        c.gray('\n重启对应 IDE 后，左侧活动栏会出现「共享会话」图标。\n') +
          c.gray('改动的 extensions.json 已备份到 ~/.xsess/backups/。\n'),
      );
    }
    return 0;
  }

  process.stderr.write(c.red(`未知子命令: ${sub}（可用 status / install / uninstall）\n`));
  return 1;
}

// ---------------------------------------------------------------- daemon

async function cmdDaemon(args) {
  const sub = args._[1] || 'status';
  const port = args.port ? parseInt(args.port, 10) : DEFAULT_PORT;

  if (sub === 'status') {
    const state = loadState();
    try {
      const r = await fetch(`http://127.0.0.1:${state.port || port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const j = /** @type {any} */ (await r.json());
      process.stdout.write(c.green('✓ ') + `daemon 在跑 · 端口 ${j.port} · pid ${j.pid}\n`);
    } catch {
      process.stdout.write(c.gray('· daemon 没在跑\n'));
      process.stdout.write(c.gray(`  前台启动: xsess daemon start\n  开机自启: xsess daemon install --write\n`));
    }
    process.stdout.write(c.gray(`  token: ~/.xsess/daemon.json\n`));
    process.stdout.write(c.gray(`  launchd: ${launchd.isInstalled() ? '已安装' : '未安装'}\n`));
    return 0;
  }

  if (sub === 'start') {
    const { startDaemon } = await import('../daemon/server.js');
    startDaemon({ port });
    process.stdout.write(c.green('✓ ') + `daemon 已启动 http://127.0.0.1:${port}\n`);
    process.stdout.write(c.gray('Ctrl-C 退出。要长期后台跑用 `xsess daemon install --write`\n'));
    return new Promise(() => {}); // 前台常驻
  }

  // daemon 常驻，改了代码它不会自己重载 —— 旧代码会照常每 30 秒扫一次，
  // 把按新逻辑扫出来的结果又覆盖回旧的。踩过一次：标题清洗改好了，
  // scan --force 出来是对的，几十秒后又变回脏值。
  if (sub === 'restart' || sub === 'stop') {
    const state = loadState();
    const targetPort = state.port || port;
    let pid = null;
    try {
      const r = await fetch(`http://127.0.0.1:${targetPort}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      pid = /** @type {any} */ (await r.json()).pid;
    } catch {
      /* 没在跑 */
    }
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        process.stdout.write(c.green('✓ ') + `已停掉旧 daemon（pid ${pid}）\n`);
      } catch (e) {
        process.stderr.write(c.red(`停不掉 pid ${pid}：${e.message}\n`));
        return 1;
      }
    } else {
      process.stdout.write(c.gray('· daemon 本来就没在跑\n'));
    }
    if (sub === 'stop') return 0;

    // 等端口释放再起，否则新进程 listen 会撞上 EADDRINUSE
    for (let i = 0; i < 20; i++) {
      try {
        await fetch(`http://127.0.0.1:${targetPort}/api/health`, { signal: AbortSignal.timeout(300) });
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        break; // 连不上了 = 端口空了
      }
    }
    const { startDaemon } = await import('../daemon/server.js');
    startDaemon({ port: targetPort });
    process.stdout.write(c.green('✓ ') + `daemon 已用当前代码重启 http://127.0.0.1:${targetPort}\n`);
    process.stdout.write(c.gray('Ctrl-C 退出。要长期后台跑用 `xsess daemon install --write`\n'));
    return new Promise(() => {});
  }

  if (sub === 'install' || sub === 'uninstall') {
    const r =
      sub === 'install' ? launchd.install({ port, write: !!args.write }) : launchd.uninstall({ write: !!args.write });
    process.stdout.write(`  ${r.ok ? c.green('✓') : c.gray('·')} ${r.detail}\n`);
    if (r.preview && !args.write) {
      process.stdout.write(indent(c.gray(r.preview), '      ') + '\n');
      process.stdout.write(c.yellow('\n这是预览。加 --write 才会真的写入并加载。\n'));
    }
    return 0;
  }

  process.stderr.write(c.red(`未知子命令: ${sub}（可用 status / start / install / uninstall）\n`));
  return 1;
}

// ---------------------------------------------------------------- 工具函数

function printSessionTable(rows, { snippet = false } = {}) {
  const titleW = Math.min(
    Math.max(...rows.map((r) => displayWidth(r.title || '')), 20),
    Math.max(40, (process.stdout.columns || 100) - 46),
  );
  for (const r of rows) {
    const sub = r.isSubagent ? c.gray(' ⟨子⟩') : '';
    // 前缀直接长在标题上（`cc：标题`），不再单开一列 ——
    // 复制粘贴一行出去的时候，来源信息也跟着走
    const titled = prefixedTitle(r.tool, r.title, titleW);
    process.stdout.write(
      `${c.gray(padEnd(relTime(r.updatedAt), 10))} ` +
        `${padEnd(titled, titleW + PREFIX_WIDTH)}${sub} ` +
        `${c.gray(padEnd(String(r.messageCount), 5))} ` +
        `${c.gray(r.cwd ? shortPath(r.cwd) : '')}\n`,
    );
    process.stdout.write(c.gray(`   ${r.id}\n`));
    if (snippet && r.snippet) {
      process.stdout.write(c.gray('   ') + r.snippet.replace(/\s+/g, ' ').slice(0, 160) + '\n');
    }
  }
}

function indent(s, pad = '   ') {
  return String(s)
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

function truncLines(s, n) {
  const lines = String(s).split('\n');
  if (lines.length <= n) return s;
  return lines.slice(0, n).join('\n') + c.gray(`\n   … 还有 ${lines.length - n} 行`);
}

function openIndexOrHint() {
  if (!exists(INDEX_DB)) {
    process.stderr.write(c.yellow('索引还没建。先跑：\n\n  xsess scan\n\n'));
    return null;
  }
  return openIndex();
}

function resolveCwdFilter(args) {
  if (args.cwd === undefined) return undefined;
  // `--cwd` 不给值就用当前目录
  return args.cwd === true || args.cwd === '' ? process.cwd() : args.cwd;
}

/** 极简参数解析：够用就好，不引 commander */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, inlineV] = a.slice(2).split('=');
      const key = camel(k);
      if (inlineV !== undefined) {
        args[key] = inlineV;
      } else {
        const next = argv[i + 1];
        // 布尔开关 vs 带值选项：下一个 token 是选项或不存在，就当布尔
        if (next === undefined || next.startsWith('-')) args[key] = true;
        else if (BOOLEAN_FLAGS.has(key)) args[key] = true;
        else {
          args[key] = next;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = SHORT[a] || a.slice(1);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('-')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  if (args.limit) args.limit = parseInt(args.limit, 10) || undefined;
  return args;
}

const BOOLEAN_FLAGS = new Set(['json', 'all', 'force', 'full', 'help', 'write', 'allowWhileRunning']);
const SHORT = { '-n': 'limit', '-h': 'help', '-t': 'tool', '-j': 'json', '-a': 'all' };

function camel(s) {
  return s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}
