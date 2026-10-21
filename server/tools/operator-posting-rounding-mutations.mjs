import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp('/tmp/posting-rounding-mutants-');
const artifact = 'test-artifacts/operator-posting-rounding/mutations';
const mutations = [
  ['too-small', 'NETSUITE_SQFT_VARIANCE_LIMIT = 0.01', 'NETSUITE_SQFT_VARIANCE_LIMIT = 0.0002'],
  ['too-large', 'NETSUITE_SQFT_VARIANCE_LIMIT = 0.01', 'NETSUITE_SQFT_VARIANCE_LIMIT = 0.02'],
  ['one-direction', 'Math.abs(left - right) < NETSUITE_SQFT_VARIANCE_LIMIT', '(left - right) < NETSUITE_SQFT_VARIANCE_LIMIT'],
  ['other-units', '!isSqftPostingUnit(unit) || !Number.isFinite(left)', '!Number.isFinite(left)'],
  ['local-instead-of-netsuite', '? Number(netSuite) : Number(local)', '? Number(local) : Number(local)']
];
await mkdir(artifact, { recursive: true });
try {
  await cp('src', `${directory}/src`, { recursive: true });
  await cp('test', `${directory}/test`, { recursive: true });
  await cp('package.json', `${directory}/package.json`);
  await symlink('/app/node_modules', `${directory}/node_modules`);
  const path = `${directory}/src/operator-netsuite-posting-quantity.js`;
  const original = await readFile(path, 'utf8');
  const results = [];
  for (const propertyOnly of [false, true]) {
    for (const [name, before, after] of mutations) {
      assert.equal(original.split(before).length, 2, `Unique mutation anchor: ${name}`);
      await writeFile(path, original.replace(before, after));
      const args = ['--test', '--test-concurrency=1'];
      if (propertyOnly) { args.push('--test-name-pattern=property'); }
      args.push('test/mbt/unit/operator-posting-rounding.test.js');
      const run = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 30000 });
      const log = (run.stdout || '') + (run.stderr || '');
      await writeFile(`${artifact}/${propertyOnly ? 'property-' : ''}${name}.log`, log);
      await writeFile(path, original);
      assert.ok(run.status !== 0 && /not ok/u.test(log) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(log), `Mutation survived or infrastructure failed: ${name}`);
      results.push({ name, propertyOnly, killed: true });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }
