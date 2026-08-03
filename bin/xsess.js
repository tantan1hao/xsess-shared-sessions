#!/usr/bin/env node
// node:sqlite 在 Node 22/24 上会打实验性警告，对 CLI 用户是纯噪音
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning' || !/SQLite/i.test(w.message)) console.warn(w);
});

import { main } from '../src/cli/index.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
