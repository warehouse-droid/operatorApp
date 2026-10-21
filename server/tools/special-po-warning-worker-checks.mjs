import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';

const source = '/workspace/server/deployments/special-po-warning-worker-20261019/candidate';
const root = '/tmp/special-po-warning-worker';
const tests = ['test/mbt/integration/special-po-warning.test.js', 'test/mbt/unit/special-stock-request-service.red.test.js'];
const results = [];
try {
  mkdirSync(root, { recursive: true });
  for (const name of ['src', 'public', 'package.json']) cpSync(`${source}/${name}`, `${root}/${name}`, { recursive: true });
  symlinkSync('/app/node_modules', `${root}/node_modules`, 'dir');
  for (const file of tests) {
    mkdirSync(`${root}/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
    cpSync(file, `${root}/${file}`);
    const result = await isolatedRun(file, { cwd: root, prefix: 'po-warning-worker' });
    results.push(result);
    console.log(JSON.stringify(result));
    assert.equal(result.exit, 0);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
writeFileSync('test-artifacts/worker-validation.json', JSON.stringify({ passed: true, results }, null, 2));
