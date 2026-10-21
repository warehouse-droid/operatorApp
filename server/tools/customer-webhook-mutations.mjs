import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const artifact = '/app/test-artifacts/customer-webhook/final/mutations';
await mkdir(artifact, { recursive: true });
const temporary = await mkdtemp('/tmp/customer-webhook-mutants-');
const mutations = [
  ['same-length-invalid-secret', 'src/netsuite-customer-webhook-router.js', '|| !timingSafeEqual(provided, expected)', '', false],
  ['wrong-account-accepted', 'src/netsuite-customer-webhook.js', 'incomingAccount !== expectedAccount', 'false', false],
  ['inactive-customer-reactivated', 'src/netsuite-customer-webhook.js', "active: boolean(row.active, 'Customer active')", 'active: true', true],
  ['changed-data-has-same-hash', 'src/netsuite-customer-webhook.js', 'payloadHash: canonicalSha256(aggregate)', "payloadHash: 'a'.repeat(64)", true],
  ['inline-edit-not-sent', 'netsuite-customer-webhook-user-event.js', "['create', 'edit', 'xedit']", "['create', 'edit']", false]
];
const results = [];
try {
  await cp('/app/src', `${temporary}/src`, { recursive: true });
  for (const type of ['integration', 'unit']) { await mkdir(`${temporary}/test/mbt/${type}`, { recursive: true }); }
  for (const file of ['test/mbt/integration/customer-webhook.test.js', 'test/mbt/unit/customer-webhook-sender.test.js',
    'package.json', 'netsuite-customer-webhook-user-event.js']) { await cp(`/app/${file}`, `${temporary}/${file}`); }
  for (const directory of ['node_modules', 'public', 'contracts']) { await symlink(`/app/${directory}`, `${temporary}/${directory}`); }
  for (const [name, file, before, after, property] of mutations) {
    const path = `${temporary}/${file}`, original = await readFile(path, 'utf8');
    assert.equal(original.split(before).length, 2, `Mutation anchor must be unique: ${name}`);
    await writeFile(path, original.replace(before, after));
    for (const mode of property ? ['suite', 'property'] : ['suite']) {
      const tests = ['test/mbt/integration/customer-webhook.test.js', 'test/mbt/unit/customer-webhook-sender.test.js'];
      const args = ['--test', '--test-concurrency=1', ...(mode === 'property' ? ['--test-name-pattern=property:'] : []), ...tests];
      const run = spawnSync(process.execPath, args, { cwd: temporary, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      const output = (run.stdout || '') + (run.stderr || '');
      await writeFile(`${artifact}/${name}-${mode}.log`, output);
      assert.ok(run.status !== 0 && /not ok/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output), `Mutation survived or infrastructure failed: ${name}/${mode}`);
      results.push({ name, mode, killed: true });
    }
    await writeFile(path, original);
    console.log(`Killed ${name}`);
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
