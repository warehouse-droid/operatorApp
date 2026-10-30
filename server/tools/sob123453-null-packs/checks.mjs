import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const out = '/app/test-artifacts';
const focused = 'test/mbt/unit/sales-order-pack-transport.test.js';
const suites = [focused, ...['special-workflow-rest-orders', 'special-so-unitless-verification',
  'special-so-creation-confirmation', 'special-stock-request-netsuite.red', 'regular-waitlist-netsuite']
  .map(name => `test/mbt/unit/${name}.test.js`)];
const files = ['src/netsuite.js', 'public/order-pack-quantities.js'];
function run(name, args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024, ...options });
  fs.writeFileSync(`${out}/${name}.log`, (result.stdout || '') + (result.stderr || ''));
  if (result.status !== 0 && !options.allowFailure) {
    process.stdout.write((result.stdout || '') + (result.stderr || ''));
    throw Error(`${name} failed with ${result.status}: ${result.error || ''}`);
  }
  return result;
}
for (const file of [...files, focused]) run(`syntax-${path.basename(file)}`, ['--check', file]);
run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/sales-order-null-packs-20261016/eslint.config.mjs', '--max-warnings=0', ...files]);
run('types', ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--skipLibCheck', 'public/order-pack-quantities.js']);
const final = run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  '--include=src/netsuite.js', '--include=public/order-pack-quantities.js', `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`,
  '--reporter=json', '--reporter=json-summary', 'node', '--test', '--test-concurrency=1', ...suites]);
const totals = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key, Number(final.stdout.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1])]));
assert.equal(totals.fail, 0);
run('reversed-order', ['--test', '--test-concurrency=1', ...[...suites].reverse()]);

const mutations = [
  ['zero preserved', 'public/order-pack-quantities.js', 'Number(value) === 0 ? null : Number(value)', 'Number(value)', true],
  ['positive lost', 'public/order-pack-quantities.js', 'Number(value) === 0 ? null : Number(value)', 'null', true],
  ['negative accepted', 'public/order-pack-quantities.js', 'Number(value) < 0', 'false', false],
  ['section overwritten', 'public/order-pack-quantities.js', "sectionQty: 'custcol_sec'", "sectionQty: 'custcol_pcs'", true],
  ['discount transport bypass', 'src/netsuite.js', 'const body = normalizeSalesOrderPackPayload(payload);\n  return mutate(()=>rest(path', 'const body = payload;\n  return mutate(()=>rest(path', true]
];
const scratch = `${out}/mutation-source`, killed = [];
try {
  fs.mkdirSync(scratch);
  for (const dir of ['src', 'public']) fs.cpSync(`/app/${dir}`, `${scratch}/${dir}`, { recursive: true });
  fs.copyFileSync('/app/package.json', `${scratch}/package.json`);
  fs.symlinkSync('/app/node_modules', `${scratch}/node_modules`);
  for (const [index, [name, file, before, after, property]] of mutations.entries()) {
    const target = `${scratch}/${file}`, source = fs.readFileSync(target, 'utf8');
    assert.equal(source.split(before).length, 2, name);
    fs.writeFileSync(target, source.replace(before, after));
    const env = { ...process.env, SO_PACK_SOURCE_ROOT: scratch };
    try {
      const result = run(`mutant-${index}`, ['--test', '--test-concurrency=1', focused], { env, allowFailure: true });
      assert.equal(result.status, 1, `${name} survived`);
      assert.match(result.stdout, /ERR_ASSERTION|Property failed/, 'Mutation must fail on behavior');
      if (property) {
        const prop = run(`mutant-property-${index}`, ['--test', '--test-name-pattern=^property:', focused], { env, allowFailure: true });
        assert.equal(prop.status, 1, `${name} survived property suite`);
        assert.match(prop.stdout, /Property failed/);
      }
      killed.push({ name, killed: true, propertyKilled: property || null });
    } finally { fs.writeFileSync(target, source); }
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
const summary = { passed: true, tests: totals, suites, syntax: 'passed', lint: '0 errors/warnings', helperTypes: '0 errors',
  mutation: killed, propertyRuns: 250, suiteHealth: 'Same suites passed in reverse file order',
  versions: { node: process.version, ...Object.fromEntries(['fast-check', 'c8', 'typescript', 'eslint'].map(name =>
    [name, JSON.parse(fs.readFileSync(`/app/node_modules/${name}/package.json`)).version])) },
  sourceHashes: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])) };
fs.writeFileSync(`${out}/validation.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ tests: totals, mutantsKilled: killed.length, propertyMutantsKilled: killed.filter(m => m.propertyKilled).length,
  staticChecks: 'passed', sourceHashes: summary.sourceHashes }));
