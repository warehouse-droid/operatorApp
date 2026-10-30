const { spawnSync } = require('node:child_process');
const [cmd, ...args] = process.argv.slice(2);
const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, NODE_PATH: '/app/node_modules', NODE_V8_COVERAGE: '/artifacts/coverage' } });
if (r.error) { console.error(r.error.message); }
process.exit(r.status ?? 1);
