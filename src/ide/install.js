/**
 * 把侧边栏扩展装进各家 VS Code 分支。
 *
 * 不走 .vsix + `code --install-extension` 那条路，原因很实际：
 * Antigravity / Cursor / Trae CN / Kiro 各有各的 CLI，未必在 PATH 上，
 * 名字也各不相同。而所有 VS Code 分支都会扫 `<数据目录>/extensions/`，
 * 直接把目录拷进去 + 在 extensions.json 里登记一条，是最通用的装法。
 *
 * 扩展本身是纯 JS，没有编译产物，所以「拷贝」就是完整的安装过程。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_DIRS, BACKUP_DIR, ensureXsessDirs, exists } from '../core/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, '../../vscode-ext');
const DAEMON_ENTRY = path.resolve(HERE, '../../bin/xsess-daemon.js');

const PUBLISHER = 'xsess';
const NAME = 'xsess-sidebar';
const VERSION = readVersion();
const FOLDER = `${PUBLISHER}.${NAME}-${VERSION}`;
const EXT_ID = `${PUBLISHER}.${NAME}`;

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'package.json'), 'utf8')).version;
  } catch {
    return '0.1.0';
  }
}

export function ideTargets() {
  return Object.entries(EXTENSION_DIRS).map(([ide, dir]) => ({
    ide,
    dir,
    present: exists(dir),
    installed: exists(path.join(dir, FOLDER, 'package.json')),
  }));
}

export function status() {
  return ideTargets();
}

/**
 * @typedef {Object} IdeResult
 * @property {string} ide
 * @property {string} action
 * @property {string} detail
 * @property {string} [manifest] extensions.json 的登记结果
 */

/**
 * @param {{ides?:string[], write?:boolean}} opts
 * @returns {IdeResult[]}
 */
export function install(opts = {}) {
  const { ides, write = false } = opts;
  const targets = ideTargets().filter((t) => t.present && (!ides || ides.includes(t.ide)));
  /** @type {IdeResult[]} */
  const results = [];

  for (const t of targets) {
    const dest = path.join(t.dir, FOLDER);
    if (!write) {
      results.push({
        ide: t.ide,
        action: t.installed ? 'would-update' : 'would-add',
        detail: dest,
      });
      continue;
    }

    try {
      // 先删旧版本目录（同名重装），再整包拷过去
      fs.rmSync(dest, { recursive: true, force: true });
      copyDir(EXT_SRC, dest);

      // 把 daemon 的绝对路径写进扩展目录，扩展启动时读它来拉起本地服务
      fs.writeFileSync(
        path.join(dest, 'config.json'),
        JSON.stringify({ daemonEntry: DAEMON_ENTRY, installedAt: new Date().toISOString() }, null, 2),
      );

      const registered = registerInManifest(t.dir, dest);
      results.push({
        ide: t.ide,
        action: t.installed ? 'updated' : 'added',
        detail: dest,
        manifest: registered,
      });
    } catch (e) {
      results.push({ ide: t.ide, action: 'error', detail: e.message });
    }
  }

  return results;
}

/**
 * @param {{ides?:string[], write?:boolean}} [opts]
 * @returns {IdeResult[]}
 */
export function uninstall(opts = {}) {
  const { ides, write = false } = opts;
  /** @type {IdeResult[]} */
  const results = [];
  for (const t of ideTargets()) {
    if (ides && !ides.includes(t.ide)) continue;
    if (!t.installed) {
      results.push({ ide: t.ide, action: 'absent', detail: '没装' });
      continue;
    }
    const dest = path.join(t.dir, FOLDER);
    if (!write) {
      results.push({ ide: t.ide, action: 'would-remove', detail: dest });
      continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    unregisterFromManifest(t.dir);
    results.push({ ide: t.ide, action: 'removed', detail: dest });
  }
  return results;
}

// ---------------------------------------------------------------- extensions.json

/**
 * VS Code 会把已装扩展缓存在 extensions.json 里。光拷目录有些版本认，有些不认，
 * 登记一条最稳妥。改之前备份 —— 这个文件坏了，IDE 的扩展列表会整个空掉。
 */
function registerInManifest(extDir, dest) {
  const manifest = path.join(extDir, 'extensions.json');
  if (!exists(manifest)) return 'skip(无 extensions.json)';

  let list;
  try {
    list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!Array.isArray(list)) return 'skip(格式不是数组)';
  } catch (e) {
    return `skip(读不了: ${e.message})`;
  }

  backup(manifest);
  const without = list.filter((e) => e?.identifier?.id !== EXT_ID);
  without.push({
    identifier: { id: EXT_ID },
    version: VERSION,
    location: { $mid: 1, path: dest, scheme: 'file' },
    relativeLocation: FOLDER,
    metadata: {
      installedTimestamp: Date.now(),
      source: 'vsix',
      private: false,
      updated: false,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false,
    },
  });
  writeAtomic(manifest, JSON.stringify(without));
  return 'ok';
}

function unregisterFromManifest(extDir) {
  const manifest = path.join(extDir, 'extensions.json');
  if (!exists(manifest)) return;
  try {
    const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!Array.isArray(list)) return;
    backup(manifest);
    writeAtomic(manifest, JSON.stringify(list.filter((e) => e?.identifier?.id !== EXT_ID)));
  } catch {
    /* 读不了就不动它 */
  }
}

// ---------------------------------------------------------------- 工具

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function backup(p) {
  ensureXsessDirs();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // IDE 的数据目录都叫 .antigravity / .cursor 之类，去掉开头的点，
  // 否则备份文件本身变成隐藏文件，`ls ~/.xsess/backups` 看不见
  const tag = path.basename(path.dirname(path.dirname(p))).replace(/^\.+/, '');
  fs.copyFileSync(p, path.join(BACKUP_DIR, `${tag}.extensions.json.${stamp}.bak`));
}

function writeAtomic(p, content) {
  const tmp = `${p}.xsess-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

export { FOLDER, EXT_ID, VERSION, EXT_SRC };
