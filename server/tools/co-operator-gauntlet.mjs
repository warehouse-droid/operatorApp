import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, cp, symlink, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from '../test/support/test-database-isolation.mjs';
import { createCoOperatorBaseline } from '../test/support/co-operator-baseline.mjs';

if (process.env.MBT_TEST_ISOLATED !== '1') {throw new Error('Use docker/run-isolated-tests.sh.');}
const artifacts = path.resolve('test-artifacts/co-operator');
await mkdir(artifacts, { recursive: true });
const changed = ['src/operator-co-routing.js', 'src/co-source-receipt.js', 'src/co-source-packing-handoff.js',
  'src/delivery-repository.js', 'src/receiving-repository.js', 'public/operator.js'];
const ownTest = 'test/dispatch/integration/co-operator-routing.test.js';
const regressions = process.argv.includes('--new-only') ? [ownTest] : [ownTest,
  'test/dispatch/integration/co-source-packing-handoff.test.js',
  'test/dispatch/integration/co-supply-reference.test.js',
  'test/dispatch/integration/co-direct-to.test.js',
  'test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js',
  'test/dispatch/integration/goa-co-planning.test.js',
  'test/dispatch/integration/dispatch-co-cargo-preservation.test.js',
  'test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js',
  'test/mbt/integration/operator-group-draft.test.js',
  'test/mbt/integration/operator-yard-access.test.js',
  'test/mbt/integration/operator-receiving-identity.test.js',
  'test/mbt/integration/co-completion.test.js',
  'test/mbt/concurrency/co-completion.test.js'];

function run(command, args, cwd = process.cwd(), env = process.env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => resolve({ code: 1, output: String(error) }));
    child.on('close', code => resolve({ code, output }));
  });
}
async function mutationRun(args, cwd) {
  const url = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: describeIsolatedTestDatabase(url).adminUrl });
  const name = isolatedTestDatabaseName(randomUUID(), 0);
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE mbt_test`);
    return await run(process.execPath, args, cwd, { ...process.env, DATABASE_URL: isolatedTestDatabaseUrl(url, name) });
  } finally {
    try {await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);} finally {await admin.end();}
  }
}
function report(label, result) {
  console.log(`${label}: exit ${result.code}`);
  const failures = result.output.match(/^not ok[^]*?^\s*\.\.\./gm) || [];
  if (failures.length) {console.log(failures.join('\n'));}
  console.log(result.output.split('\n').filter(line => /^# (tests|pass|fail|duration_ms)|^ℹ (tests|pass|fail)|^✖ |^Isolated |^All files|^Changed |^src\/|^CO static|operator-co-routing.js|co-source-receipt.js/.test(line)).join('\n'));
  if (result.code && !failures.length && !failedNames(result).size) {console.log(result.output.slice(-7000));}
}
function failedNames(result) {
  return new Set([...result.output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gm)].map(match => match[1]));
}
async function check(label, command, args) {
  const result = await run(command, args);
  await writeFile(path.join(artifacts, `${label}.log`), result.output);
  report(label, result);
  if (result.code) {throw new Error(`${label} failed`);}
}

async function baselineResult() {
  const baseline = path.join(artifacts, 'baseline');
  try {
    await createCoOperatorBaseline(baseline);
    const result = await run(process.execPath, ['tools/run-co-operator-regressions.mjs', ...regressions.filter(file => file !== ownTest)], baseline);
    await writeFile(path.join(artifacts, 'baseline.log'), result.output);
    report('baseline', result);
    if (result.code && !failedNames(result).size) {throw new Error('Baseline infrastructure failed.');}
    return result;
  } finally { await rm(baseline, { recursive: true, force: true }); }
}
if (process.argv.includes('--baseline')) {
  await baselineResult();
  process.exit(0);
}

for (const file of changed) {await check(`syntax-${path.basename(file)}`, process.execPath, ['--check', file]);}
await check('lint', process.execPath, ['tools/co-operator-static.mjs']);
const baseline = process.argv.includes('--new-only') ? { output: '', code: 0 } : await baselineResult();
const regression = await run('./node_modules/.bin/c8', ['--all=false', '--check-coverage=false', '--include=src/operator-co-routing.js',
  '--include=src/co-source-receipt.js', '--include=src/co-source-packing-handoff.js', '--include=src/delivery-repository.js',
  '--include=src/receiving-repository.js', `--temp-directory=${artifacts}/v8`, `--reports-dir=${artifacts}/coverage`,
  '--reporter=text', '--reporter=json', '--reporter=json-summary',
  process.execPath, 'tools/run-co-operator-regressions.mjs', ...regressions.toReversed()]);
await writeFile(path.join(artifacts, 'regression.log'), regression.output);
report('regression', regression);
const newFailures = [...failedNames(regression)].filter(name => !failedNames(baseline).has(name));
if (newFailures.length || (regression.code && !failedNames(regression).size)) {
  console.log(regression.output.slice(-18000));
  throw new Error(`New regression failures: ${newFailures.join(', ') || 'infrastructure'}`);
}
console.log(`Regression comparison: ${failedNames(baseline).size} baseline failures, ${newFailures.length} new failures.`);
await check('changed-coverage', process.execPath, ['tools/check-co-operator-coverage.mjs', `${artifacts}/coverage`]);
if (process.argv.includes('--quick')) {process.exit(0);}

const workspace = path.join(artifacts, 'mutation');
await mkdir(path.join(workspace, 'test/dispatch/integration'), { recursive: true });
await mkdir(path.join(workspace, 'test/support'), { recursive: true });
await cp('src', path.join(workspace, 'src'), { recursive: true });
await cp(ownTest, path.join(workspace, ownTest));
await cp('test/support/group-underpack-fixture.mjs', path.join(workspace, 'test/support/group-underpack-fixture.mjs'));
await cp('package.json', path.join(workspace, 'package.json'));
for (const name of ['node_modules', 'public', 'migrations']) {await symlink(path.resolve(name), path.join(workspace, name));}
const mutants = [
  ['grouping', 'src/delivery-repository.js', 'if (sources.length === 1) return sources[0];', 'if (sources.length > 0) return sources[0];'],
  ['member-route', 'src/operator-co-routing.js', "OR co.details->'childOrderIds' ? ${order}.tranid", 'OR false'],
  ['receipt-status', 'src/co-source-receipt.js', "operator_status='packed'", "operator_status='open'"],
  ['repeat-receipt', 'src/co-source-receipt.js', "!['planned', 'completed'].includes(co.status) || co.received_at", 'false'],
  ['receipt-lock', 'src/co-source-receipt.js', 'if (co) {await lockConsolidatedLoadOrders([co.delivery_order_id]);}', 'if (co) {void co;}'],
  ['packing-capacity', 'src/delivery-repository.js', 'if (!hasConversion(line)) return quantities;', 'if (true) return quantities;']
];
try {
  for (const [name, file, from, to] of mutants) {
    const target = path.join(workspace, file);
    const original = await readFile(target, 'utf8');
    if (original.split(from).length !== 2) {throw new Error(`Mutation anchor is not unique: ${name}`);}
    await writeFile(target, original.replace(from, to));
    try {
      const result = await mutationRun(['--test', '--test-concurrency=1', ownTest], workspace);
      await writeFile(path.join(artifacts, `mutant-${name}.log`), result.output);
      if (!result.code || !result.output.includes('not ok')) {throw new Error(`Surviving mutant: ${name}`);}
      console.log(`mutant ${name}: killed`);
      if (['grouping', 'packing-capacity'].includes(name)) {
        const property = await mutationRun(['--test', '--test-name-pattern=generated combined', ownTest], workspace);
        if (!property.code || !property.output.includes('not ok')) {throw new Error(`Property missed mutant: ${name}`);}
        console.log(`property-only mutant ${name}: killed`);
      }
    } finally { await writeFile(target, original); }
  }
} finally { await rm(workspace, { recursive: true, force: true }); }
await check('final-co', process.execPath, ['tools/run-co-operator-regressions.mjs', ownTest]);
const hashes = {};
for (const file of [...changed, ownTest]) {hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');}
console.log(JSON.stringify({ node: process.version, hashes }));
