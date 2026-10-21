import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=confirming Group',
  'test/dispatch/frontend/edit-group-reliability.browser.test.mjs'], { stdio: 'inherit', timeout: 30000 });
process.exitCode = result.status || 0;
