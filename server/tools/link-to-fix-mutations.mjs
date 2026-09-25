import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mutants } from '../test/support/link-to-fix-mutation-loader.mjs';

export async function runMutations(folder) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const integration = ['test/mbt/unit/link-to-fix.test.js', 'test/mbt/unit/group-action-ui.test.js',
    'test/mbt/integration/link-to-fix.test.js', 'test/mbt/integration/group-action-fix.test.js'];
  const properties = ['test/mbt/property/link-to-fix.property.test.js'];
  const run = (name, files, mutant = '') => {
    const result = spawnSync(process.execPath, ['--experimental-loader', './test/support/link-to-fix-mutation-loader.mjs',
      '--test', '--test-concurrency=1', ...files], { encoding: 'utf8', maxBuffer: 30e6,
      env: { ...process.env, LINK_TO_MUTANT: mutant } });
    writeFileSync(`${folder}/mutant-${name}.log`, result.stdout + result.stderr);
    assert.ifError(result.error);
    assert.ok([0, 1].includes(result.status));
    return { status: result.status, killed: result.status === 1 && result.stdout.includes('not ok') };
  };
  const results = Object.keys(mutants).map(name => ({ name, killed: run(name, integration, name).killed,
    propertiesKilled: run(name + '-property', properties, name).killed }));
  assert.equal(run('restored', [...integration, ...properties]).status, 0);
  writeFileSync(`${folder}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  assert.ok(results.every(row => row.killed));
}
