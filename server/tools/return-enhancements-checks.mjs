import assert from 'node:assert/strict';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const output = 'test-artifacts/return-enhancements';
mkdirSync(output, { recursive: true });
const acceptance = ['test/mbt/unit/return-enhancements.test.js', 'test/mbt/unit/return-enhancements-ui.test.js',
  'test/mbt/integration/return-enhancements.test.js'];
const regressions = ['unit', 'integration'].flatMap(kind => readdirSync(`test/mbt/${kind}`)
  .filter(name => /^return-.*\.test\.js$/.test(name) && !name.startsWith('return-enhancements'))
  .map(name => `test/mbt/${kind}/${name}`));
regressions.push('test/mbt/unit/operator-display-settings.test.js', 'test/mbt/unit/operator-receiving-return.test.js',
  'test/mbt/integration/stock-return-draft-insert.test.js');
let failed = false;
const summary = {};
for (const [name, tests] of [['acceptance', acceptance], ['regressions', regressions]]) {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    encoding: 'utf8', maxBuffer: 20e6, timeout: 240000
  });
  assert.ifError(result.error);
  const text = result.stdout + result.stderr;
  writeFileSync(`${output}/${name}.log`, text);
  console.log(name, text.match(/^# (tests|pass|fail|skipped).*$/gm)?.join('; '));
  summary[name] = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(text.match(new RegExp(`^# ${key} (\\d+)`, 'm'))?.[1] || 0)]));
  if (result.status !== 0) {
    const failures = text.match(/^not ok[^]*?^  \.\.\./gm);
    console.log(failures?.slice(0, 8).join('\n') || text.slice(-6000));
    if (failures?.length > 8) { console.log(failures.slice(8).map(value => value.split('\n')[0]).join('\n')); }
    failed = true;
  }
}
writeFileSync(`${output}/suites.json`, JSON.stringify(summary, null, 2));
assert.equal(failed, false);
