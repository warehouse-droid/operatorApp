import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
mkdirSync('test-artifacts/return-enhancements', { recursive: true });
const files = ['unit', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^return-.*\.test\.js$/.test(name) && !name.startsWith('return-enhancements'))
  .map(name => `test/mbt/${kind}/${name}`));
for (const [name, tests, red] of [['baseline', files, false], ['red', [
  'test/mbt/unit/return-enhancements.test.js', 'test/mbt/unit/return-enhancements-ui.test.js',
  'test/mbt/integration/return-enhancements.test.js'], true]]) {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    encoding: 'utf8', maxBuffer: 20e6, timeout: 240000
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  writeFileSync(`test-artifacts/return-enhancements/${name}.log`, output);
  console.log(name, output.match(/^# (tests|pass|fail|skipped).*$/gm)?.join('; '));
  console.log(output.match(/^not ok .*$/gm)?.join('\n') || 'No failures');
  if (red) { assert.notEqual(result.status, 0); }
}
