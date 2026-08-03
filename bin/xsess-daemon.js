#!/usr/bin/env node
/**
 * daemon 入口。前台运行；开机自启由 launchd 负责（`xsess daemon install`）。
 */
process.removeAllListeners('warning');
process.on('warning', () => {});

import { startDaemon, DEFAULT_PORT } from '../src/daemon/server.js';

const portArg = process.argv.indexOf('--port');
const port = portArg > -1 ? parseInt(process.argv[portArg + 1], 10) : DEFAULT_PORT;

const { state } = startDaemon({ port });
process.stderr.write(`[xsess] daemon 已启动 http://127.0.0.1:${port}\n`);
process.stderr.write(`[xsess] token 在 ~/.xsess/daemon.json\n`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    process.stderr.write('\n[xsess] 收到 ' + sig + '，退出\n');
    process.exit(0);
  });
}
