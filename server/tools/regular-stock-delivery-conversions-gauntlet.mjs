import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdtemp, readFile, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {regularTests} from './regular-stock-v2-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const file = 'src/stock-request-repository.js';
const regression = 'test/mbt/integration/regular-stock-delivery-conversions.test.js';
const legacy = JSON.parse(await readFile('package.json', 'utf8')).scripts['test:stock-requests'].split(' ').filter(arg => arg.endsWith('.js'));
const suite = [...new Set([...regularTests, ...legacy])];
const layers = [];
async function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 40_000_000, ...options});
  const output = result.stdout + result.stderr;
  await writeFile('test-artifacts/' + name + '.log', output);
  layers.push({name, exitCode: result.status});
  assert.equal(result.status, 0, output);
  return output;
}
const output = await run('coverage', process.execPath, ['node_modules/c8/bin/c8.js', '--include=' + file,
  '--check-coverage=false', '--reporter=json', '--reporter=text', '--report-dir=test-artifacts/coverage', '--temp-directory=/tmp/delivery-conversions-c8',
  'node', '--test', '--test-concurrency=1', ...suite]);
await run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/regular-stock-v2-eslint.config.mjs', file, regression, 'tools/regular-stock-delivery-conversions-gauntlet.mjs']);
await run('syntax', process.execPath, ['--check', file]);
await run('types', 'node_modules/.bin/tsc', ['-p', 'tools/regular-stock-delivery-simple-tsconfig.json']);
const coverage = JSON.parse(await readFile('test-artifacts/coverage/coverage-final.json', 'utf8'))[resolve(file)];
const changed = JSON.parse(await readFile('tools/regular-stock-delivery-conversions-changed-lines.json', 'utf8'))[file];
const executable = changed.filter(number => Object.values(coverage.statementMap).some(value => value.start.line <= number && value.end.line >= number));
for (const number of executable) {
  assert(Object.entries(coverage.statementMap).some(([key, value]) => value.start.line <= number && value.end.line >= number && coverage.s[key] > 0), 'Uncovered changed line ' + number);
}
const original = await readFile(file, 'utf8');
const mutations = [
  ['omit calculated packing counts', 'pallets:packing.palletQty,layers:packing.layerQty,sections:packing.sectionQty,pieces:packing.pieceQty', 'pallets:null,layers:null,sections:null,pieces:null'],
  ['send stale packing counts to transfer', 'pallet_qty:line.pallets,layer_qty:line.layers,section_qty:line.sections,piece_qty:line.pieces,', ''],
  ['leave persisted request counts stale', 'pallet_qty=$7,layer_qty=$8,section_qty=$9,piece_qty=$10,updated_at=now()', 'pallet_qty=COALESCE(pallet_qty,$7),layer_qty=COALESCE(layer_qty,$8),section_qty=COALESCE(section_qty,$9),piece_qty=COALESCE(piece_qty,$10),updated_at=now()']
];
const temporary = await mkdtemp(join(tmpdir(), 'delivery-conversions-mutants-')), mutants = [];
try {
  for (const folder of ['src', 'public', 'test']) await cp(resolve(folder), join(temporary, folder), {recursive: true});
  await cp('package.json', join(temporary, 'package.json'));
  await symlink(resolve('node_modules'), join(temporary, 'node_modules'), 'dir');
  for (const [name, needle, replacement] of mutations) {
    assert(original.includes(needle), name);
    await writeFile(join(temporary, file), original.replace(needle, replacement));
    for (const propertiesOnly of [false, true]) {
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...(propertiesOnly ? ['--test-name-pattern=property:'] : []), regression],
        {cwd: temporary, encoding: 'utf8', timeout: 60000, maxBuffer: 20_000_000});
      await writeFile('test-artifacts/mutant-' + mutants.length + '-' + propertiesOnly + '.tap', result.stdout + result.stderr);
      assert.equal(result.status, 1, name);
      assert.match(result.stdout, /not ok/);
    }
    await writeFile(join(temporary, file), original);
    mutants.push({name, killedByRegression: true, killedByProperties: true});
  }
  await run('restored', process.execPath, ['--test', '--test-concurrency=1', regression], {cwd: temporary});
} finally {
  await rm(temporary, {recursive: true, force: true});
}
let seed = 121863;
const shuffled = suite.slice();
for (let index = shuffled.length - 1; index > 0; index--) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  const target = seed % (index + 1);
  [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
}
for (let index = 0; index < shuffled.length; index++) await run('random-' + index, process.execPath, ['--test', shuffled[index]]);
const report = {tests: Number(output.match(/^# tests (\d+)/m)?.[1]), passed: Number(output.match(/^# pass (\d+)/m)?.[1]),
  layers, coveredChangedLines: {[file]: executable}, mutants, propertyCases: 96, propertySeeds: [121863, 121864],
  randomOrderSeed: 121863, randomOrder: shuffled, sourceHashes: {[file]: createHash('sha256').update(original).digest('hex')},
  dependenciesChanged: false, schemaChanged: false, capabilityChange: 'No new runtime network or process capabilities'};
await writeFile('test-artifacts/checks.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
