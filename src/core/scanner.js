/**
 * 增量扫描器。
 *
 * 每个源（文件 / 数据库）记一条 mtime+size 水位线，没变过就整个跳过解析。
 * 这是 301 个 Codex rollout 能秒扫完的原因 —— 第一次全量，之后只碰改过的。
 *
 * 一个源解析失败不会中断整次扫描：错误记进 sources 表，`xsess doctor` 能看到。
 * 这条很重要，因为 Antigravity / Cursor 的格式会随版本变，
 * 我们要的是「那家索引不动了」而不是「整个索引挂了」。
 */

import { ADAPTERS, getAdapter } from './adapters/index.js';

/**
 * @param {ReturnType<typeof import('./index-db.js').openIndex>} index
 * @param {{tools?:string[], force?:boolean, onProgress?:(e:any)=>void}} [opts]
 */
export async function scan(index, opts = {}) {
  const { tools, force = false, onProgress } = opts;
  const targets = tools && tools.length ? tools.map(getAdapter).filter(Boolean) : ADAPTERS;

  const report = {
    started: new Date().toISOString(),
    tools: /** @type {Record<string, any>} */ ({}),
    totals: { discovered: 0, parsed: 0, skipped: 0, failed: 0, sessions: 0 },
  };

  for (const adapter of targets) {
    const t = { discovered: 0, parsed: 0, skipped: 0, failed: 0, sessions: 0, errors: [] };
    report.tools[adapter.tool] = t;

    if (!adapter.available()) {
      t.unavailable = true;
      onProgress?.({ tool: adapter.tool, phase: 'unavailable' });
      continue;
    }

    let sources = [];
    try {
      sources = await adapter.discover();
    } catch (e) {
      t.failed++;
      t.errors.push(`discover: ${e.message}`);
      onProgress?.({ tool: adapter.tool, phase: 'discover-failed', error: e });
      continue;
    }

    t.discovered = sources.length;
    report.totals.discovered += sources.length;
    onProgress?.({ tool: adapter.tool, phase: 'discovered', count: sources.length });

    // 先清掉已经消失的源，再处理新增/变更。
    // 顺序很重要：如果放在后面，本次 discover 到的源刚写进去就可能被误判为「不在了」。
    t.pruned = index.pruneMissingSources(adapter.tool, new Set(sources.map((s) => s.sourceId)));
    report.totals.pruned = (report.totals.pruned || 0) + t.pruned;

    for (const src of sources) {
      if (!force && index.isFresh(src)) {
        t.skipped++;
        report.totals.skipped++;
        continue;
      }
      try {
        const sessions = await adapter.parse(src);
        index.replaceSource(src, adapter.tool, sessions);
        t.parsed++;
        t.sessions += sessions.length;
        report.totals.parsed++;
        report.totals.sessions += sessions.length;
        onProgress?.({
          tool: adapter.tool,
          phase: 'parsed',
          path: src.path,
          sessions: sessions.length,
          done: t.parsed + t.skipped,
          total: sources.length,
        });
      } catch (e) {
        index.markSourceError(src, adapter.tool, e);
        t.failed++;
        report.totals.failed++;
        if (t.errors.length < 5) t.errors.push(`${src.path}: ${e.message}`);
        onProgress?.({ tool: adapter.tool, phase: 'failed', path: src.path, error: e });
      }
    }
  }

  report.finished = new Date().toISOString();
  report.durationMs = new Date(report.finished).getTime() - new Date(report.started).getTime();
  return report;
}
