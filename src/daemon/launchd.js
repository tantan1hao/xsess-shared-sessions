/**
 * launchd 开机自启（macOS）。
 *
 * 跟 opencodex 的 `ocx start` 一个路子：写一个 LaunchAgent plist 到
 * ~/Library/LaunchAgents/，然后 launchctl 加载。
 * 默认只预览，加 --write 才真的写入并加载。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { XSESS_HOME, ensureXsessDirs, exists } from '../core/paths.js';

const LABEL = 'com.xsess.daemon';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY = path.resolve(HERE, '../../bin/xsess-daemon.js');

export function isInstalled() {
  return exists(PLIST);
}

export function plistPath() {
  return PLIST;
}

function buildPlist(port) {
  const logOut = path.join(XSESS_HOME, 'daemon.log');
  const logErr = path.join(XSESS_HOME, 'daemon.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${DAEMON_ENTRY}</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logOut}</string>
  <key>StandardErrorPath</key><string>${logErr}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function install({ port = 10180, write = false } = {}) {
  if (process.platform !== 'darwin') {
    return { ok: false, detail: 'launchd 只在 macOS 上有；其它系统请自己用 systemd / 计划任务' };
  }
  const content = buildPlist(port);
  if (!write) {
    return { ok: false, detail: `将写入 ${PLIST}`, preview: content };
  }
  ensureXsessDirs();
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, content, 'utf8');
  try {
    // bootout 先清掉旧的；没加载过会报错，忽略即可
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
    } catch {
      /* 本来就没加载 */
    }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' });
    return { ok: true, detail: `已写入并加载 ${PLIST}（端口 ${port}）` };
  } catch (e) {
    return { ok: false, detail: `plist 已写入但 launchctl 加载失败: ${e.message}` };
  }
}

export function uninstall({ write = false } = {}) {
  if (!exists(PLIST)) return { ok: true, detail: '本来就没安装' };
  if (!write) return { ok: false, detail: `将卸载并删除 ${PLIST}` };
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    /* 没加载 */
  }
  fs.rmSync(PLIST, { force: true });
  return { ok: true, detail: `已卸载并删除 ${PLIST}` };
}
