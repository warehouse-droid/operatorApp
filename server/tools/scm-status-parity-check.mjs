import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

const files = ['src/dispatch-repository.js', 'src/scm-purchase-order-catalog-repository.js',
  'public/dispatch-scm.js', 'public/dispatch-scm.html'];
const lint = new ESLint({overrideConfigFile: resolve('tools/stock-request-layout-eslint.config.mjs')});
const existingFindings = {};
for (const file of files.filter(name => name.endsWith('.js'))) {
  const syntax = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  assert.equal(syntax.status, 0, syntax.stderr);
  const messages = async source => (await lint.lintText(source, {filePath: file}))[0].messages
    .map(({ruleId, severity, message}) => JSON.stringify({ruleId, severity, message}));
  const before = await messages(readFileSync('test-artifacts/scm-status-parity-20261001/before/' + file, 'utf8'));
  existingFindings[file] = before.length;
  const after = await messages(readFileSync(file, 'utf8'));
  const added = after.filter(message => {
    const index = before.indexOf(message);
    if (index < 0) return true;
    before.splice(index, 1);
    return false;
  });
  assert.deepEqual(added, [], file + ' has new lint findings');
}
assert.deepEqual(scanUnifiedDiff(readFileSync('test-artifacts/scm-status-parity-20261001/changes.patch', 'utf8')), []);
const tests = await lint.lintFiles(['test/dispatch/integration/scm-schedule-split-parity.test.js']);
assert.deepEqual(tests.flatMap(result => result.messages), []);
console.log(JSON.stringify({syntax: true, newLintFindings: 0, secretFindings: 0, existingFindings,
  sourceHashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))}));
