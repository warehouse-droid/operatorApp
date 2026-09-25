import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { scanTextForSecrets, scanUnifiedDiff } from '../test/support/scan-diff-secrets.mjs';

const root = 'test-artifacts/dispatch-save-reliability';
const files = [...Object.keys(JSON.parse(await readFile(`${root}/checks.json`, 'utf8')).sources),
  'src/scm-dependency-plan-reconciler.js', 'public/dispatch.html', 'public/dispatch-snapshot.html'];
const findings = [];
for (const file of new Set(files)) {
  const before = await readFile(`${root}/baseline/${file}`).then(() => `${root}/baseline/${file}`).catch(() => '/dev/null');
  const diff = spawnSync('diff', ['-U0', before, file], { encoding: 'utf8' });
  assert.ok([0, 1].includes(diff.status));
  findings.push(...scanUnifiedDiff(diff.stdout));
}
for (const directory of ['tools', 'test/dispatch/frontend', 'test/dispatch/integration', 'test/dispatch/property', 'test/dispatch/unit', 'test/support']) {
  for (const name of await readdir(directory)) {
    if (!/^dispatch-save-(?!recovery)/.test(name)) continue;
    const file = `${directory}/${name}`;
    findings.push(...scanTextForSecrets(await readFile(file, 'utf8'), file));
  }
}
const workflow = '/workspace/.github/workflows/dispatch-save.yml';
findings.push(...scanTextForSecrets(await readFile(workflow, 'utf8'), workflow));
const compatibilityTest = 'test/mbt/unit/dispatch-bin-disabled-ui.test.js';
findings.push(...scanTextForSecrets(await readFile(compatibilityTest, 'utf8'), compatibilityTest));
await writeFile(`${root}/secrets.json`, JSON.stringify({ findings }, null, 2));
console.log(JSON.stringify({ findings }));
assert.equal(findings.length, 0, 'Secret scan findings require review');
