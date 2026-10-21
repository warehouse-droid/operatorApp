import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const file = 'src/regular-stock-handoff.js';
const regression = 'test/mbt/integration/regular-stock-so-scope.test.js';
const source = await readFile(file, 'utf8');
const start = source.indexOf('      if(fresh.id!==original.id');
const end = source.indexOf("throw regularError('The SO changed after approval was linked.", start);
assert(start > 0 && end > start);
const mutations = [
  ['bypass all order validation', source.slice(start, end), '      if(false)'],
  ['reject unchanged selected items', 'current.itemId!==line.itemId', 'current.itemId===line.itemId']
];
const temporary = await mkdtemp(join(tmpdir(), 'so-scope-adversarial-'));
const results = [];
async function execute(name, args) {
  const result = spawnSync(process.execPath, args, {cwd: temporary, encoding: 'utf8', timeout: 60000, maxBuffer: 10_000_000});
  await writeFile(`test-artifacts/${name}.log`, (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.signal, null);
  return {exitCode: result.status, failures: [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1])};
}
try {
  await cp('src', join(temporary, 'src'), {recursive: true});
  await mkdir(join(temporary, 'test/mbt/integration'), {recursive: true});
  await cp(regression, join(temporary, regression));
  await cp('package.json', join(temporary, 'package.json'));
  await symlink(resolve('node_modules'), join(temporary, 'node_modules'), 'dir');
  await symlink(resolve('public'), join(temporary, 'public'), 'dir');
  for (const [index, [name, needle, replacement]] of mutations.entries()) {
    assert.equal(source.split(needle).length, 2);
    await writeFile(join(temporary, file), source.replace(needle, replacement));
    const full = await execute(`mutant-${index}`, ['--test', regression]);
    const properties = await execute(`mutant-${index}-properties`, ['--test', '--test-name-pattern=property:', regression]);
    assert.equal(full.exitCode, 1);
    assert.equal(properties.exitCode, 1);
    assert(full.failures.length > 0 && properties.failures.length > 0);
    results.push({name, killed: true, killedByProperties: true, ...full});
  }
  await writeFile(join(temporary, file), source);
  assert.equal((await execute('restored', ['--test', regression])).exitCode, 0);
} finally {
  await rm(temporary, {recursive: true, force: true});
}
const ordinary = JSON.parse(await readFile('/final/report.json', 'utf8'));
const red = JSON.parse(await readFile('/red/report.json', 'utf8'));
const killedNames = new Set([...results.flatMap(result => result.failures),
  ...ordinary.layers.filter(row => row.name.startsWith('mutant-')).flatMap(row => row.failures),
  ...red.layers[0].failures]);
const names = [...(await readFile('/final/focused.log', 'utf8')).matchAll(/^# Subtest: (.+)$/gm)].map(match => match[1]);
const newNames = names.filter(name => !['delivery with a committed kit issues only the backordered material and retries without a duplicate TO',
  'manual approval with a committed kit creates the corresponding material transfer',
  'real SO SQL projection anchors hidden components to their kit parent'].includes(name));
assert.deepEqual(newNames.filter(name => !killedNames.has(name)), [], 'Every new or changed test must have an observed behavioral failure');
const report = {passed: true, sourceHash: createHash('sha256').update(source).digest('hex'), results, individuallyVerifiedTests: newNames.length};
await writeFile('test-artifacts/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
