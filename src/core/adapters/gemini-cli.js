/**
 * Gemini CLI 适配器 —— `~/.gemini/tmp/<项目名>/chats/session-*.jsonl`
 *
 * 首行是会话元数据 `{sessionId, projectHash, startTime, lastUpdated, kind}`，
 * 后续每行一条记录：
 *   type:"user"    content 是 [{text}] 数组
 *   type:"gemini"  content 是字符串，另带 model / tokens / thoughts
 *   type:"info"    系统提示（"Request cancelled." 之类）
 *   {"$set":{...}} 元数据增量更新，不是消息
 *
 * cwd 不在会话里，但同级 `~/.gemini/tmp/<项目名>/.project_root` 存了项目根路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, exists } from '../paths.js';
import { readJsonl, walkFiles } from '../jsonl.js';
import { cleanText, makeSession, toIso } from '../model.js';

const TOOL = 'gemini-cli';
const ROOT = TOOLS[TOOL].tmp;

export const adapter = {
  tool: TOOL,
  displayName: TOOLS[TOOL].displayName,

  available() {
    return exists(ROOT);
  },

  async discover() {
    if (!exists(ROOT)) return [];
    return walkFiles(
      ROOT,
      (name, p) => name.startsWith('session-') && name.endsWith('.jsonl') && p.includes('/chats/'),
      { maxDepth: 4 },
    ).map((f) => ({
      sourceId: `${TOOL}:${f.path}`,
      path: f.path,
      mtimeMs: f.mtimeMs,
      size: f.size,
    }));
  },

  async parse(src) {
    /** @type {any} */
    let head = null;
    let lastUpdated = null;
    let model = null;
    const messages = [];

    await readJsonl(src.path, (rec) => {
      if (rec.$set) {
        if (rec.$set.lastUpdated) lastUpdated = rec.$set.lastUpdated;
        return;
      }
      if (!head && rec.sessionId && rec.projectHash) {
        head = rec;
        return;
      }
      if (rec.model) model = rec.model;

      const ts = toIso(rec.timestamp);
      switch (rec.type) {
        case 'user': {
          const text = cleanText(flattenContent(rec.content));
          if (text) messages.push({ role: 'user', text, ts });
          break;
        }
        case 'gemini': {
          const text = cleanText(flattenContent(rec.content));
          if (text) {
            messages.push({
              role: 'assistant',
              text,
              ts,
              meta: rec.model ? { model: rec.model } : undefined,
            });
          }
          break;
        }
        case 'info':
        case 'error': {
          const text = cleanText(flattenContent(rec.content));
          if (text) messages.push({ role: 'system', text, ts });
          break;
        }
        default:
          break;
      }
    });

    const nativeId =
      (head && head.sessionId) ||
      path.basename(src.path).replace(/^session-/, '').replace(/\.jsonl$/, '');

    return [
      makeSession({
        tool: TOOL,
        nativeId,
        title: null,
        cwd: projectRootOf(src.path),
        gitBranch: null,
        model,
        startedAt: toIso(head && head.startTime),
        updatedAt: toIso(lastUpdated || (head && head.lastUpdated)),
        isSubagent: !!(head && head.kind && head.kind !== 'main'),
        sourceId: src.sourceId,
        path: src.path,
        meta: { projectHash: head && head.projectHash, kind: head && head.kind },
        messages,
      }),
    ];
  },
};

function flattenContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' ? b.text || '' : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof c === 'object' && c.text) return c.text;
  return '';
}

/** `.../tmp/<项目名>/chats/session-x.jsonl` → 读同级 `.project_root` */
function projectRootOf(sessionPath) {
  try {
    const projectDir = path.dirname(path.dirname(sessionPath)); // 去掉 chats/ 和文件名
    const marker = path.join(projectDir, '.project_root');
    if (!exists(marker)) return null;
    const v = fs.readFileSync(marker, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}
