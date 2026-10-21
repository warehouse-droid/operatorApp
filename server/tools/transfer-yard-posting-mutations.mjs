import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const artifact = '/app/test-artifacts/transfer-yard-posting-20261021/final/mutations';
await mkdir(artifact, { recursive: true });
const temporary = await mkdtemp('/tmp/transfer-yard-mutants-');
const mutations = [
  ['driver-required-again', "if (!job.snapshot.driverTarget) {return {id:null};}", "if (!job.snapshot.driverTarget) {return null;}"],
  ['if-waits-for-receipt', "return itemQuantities([job]).size ? null : 'waiting_load';", "return itemQuantities([job]).size ? 'waiting_receipt' : 'waiting_load';"],
  ['ir-skips-verified-if', "if(job.transaction_type==='IR' && loads.some", "if(job.transaction_type==='NEVER' && loads.some"],
  ['over-receipt-accepted', "if([...received].some", "if(false && [...received].some"],
  ['operator-record-optional', "if (!job.operator_record_id) {return null;}", "if (false) {return null;}"]
];
try {
  await cp('/app/src', `${temporary}/src`, { recursive: true });
  for (const name of ['test/mbt/unit/transfer-order-background-posting.test.js', 'test/mbt/property/operator-to-yard-flow.property.test.js', 'package.json']) {
    const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    if (parent) { await mkdir(`${temporary}/${parent}`, { recursive: true }); }
    await cp(`/app/${name}`, `${temporary}/${name}`);
  }
  for (const directory of ['node_modules', 'public', 'contracts']) {
    await symlink(`/app/${directory}`, `${temporary}/${directory}`);
  }
  const path = `${temporary}/src/transfer-order-posting-domain.js`, original = await readFile(path, 'utf8'), results = [];
  for (const [name, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, `Unique mutation anchor: ${name}`);
    await writeFile(path, original.replace(before, after));
    const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-name-pattern=^property:',
      'test/mbt/unit/transfer-order-background-posting.test.js', 'test/mbt/property/operator-to-yard-flow.property.test.js'],
    { cwd: temporary, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(path, original);
    const output = (run.stdout || '') + (run.stderr || '');
    await writeFile(`${artifact}/${name}.log`, output);
    assert.ok(run.status !== 0 && /not ok/u.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(output), `Mutation survived or infrastructure failed: ${name}`);
    results.push({ name, killed: true, propertyOnly: true });
    console.log(`Killed ${name} with properties alone`);
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
