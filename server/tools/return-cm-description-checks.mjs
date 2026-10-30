import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const output = 'test-artifacts/return-cm-description';
fs.mkdirSync(output, { recursive: true });
const files = JSON.parse(fs.readFileSync('tools/return-cm-description-files.json'));
const acceptance = ['test/mbt/unit/return-cm-description.test.js', 'test/mbt/integration/return-cm-description.test.js'];
const layers = {};
function run(name, args, { cwd = process.cwd(), mutant = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 240000, maxBuffer: 30e6 });
  assert.ifError(result.error);
  const text = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(`${output}/${name}.log`, text);
  if (mutant) assert.notEqual(result.status, 0, `${name} survived`);
  else assert.equal(result.status, 0, `${name}:\n${text.slice(-16000)}`);
  layers[name] = { passed: true, ...(mutant ? { mutantKilled: true } : {}),
    summary: text.match(/^# (tests|pass|fail|skipped).*$/gm) || [] };
  console.log(name, mutant ? 'killed' : 'passed', layers[name].summary.join('; '));
}
const tests = ['--test', '--test-concurrency=1'];
run('acceptance', [...tests, ...acceptance]);
if (process.argv.includes('--focused')) process.exit(0);
for (const file of files) run(`syntax-${path.basename(file)}`, ['--check', file]);
run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/return-cm-description-eslint.config.mjs', '--max-warnings=0',
  'src/return-credit-memo-adjustment.js', 'src/return-credit-memo.js', 'src/return-accounting.js', ...acceptance]);
assert.deepEqual([...files, ...acceptance].flatMap(file => scanTextForSecrets(fs.readFileSync(file, 'utf8'), file)), []);

const typeRoot = path.resolve(output, 'types');
try {
  fs.mkdirSync(`${typeRoot}/src`, { recursive: true }); fs.mkdirSync(`${typeRoot}/public`, { recursive: true });
  fs.writeFileSync(`${typeRoot}/package.json`, '{"type":"module"}');
  fs.symlinkSync(path.resolve('node_modules'), `${typeRoot}/node_modules`, 'dir');
  const typed = files.filter(file => !file.endsWith('return-batch-ra-service.js'));
  for (const file of typed) fs.copyFileSync(file, `${typeRoot}/${file}`);
  for (const file of ['special-stock-pricing.js', 'special-stock-calendar.js']) fs.copyFileSync(`public/${file}`, `${typeRoot}/public/${file}`);
  const declarations = {
    'db.d.ts': 'export function query(sql:string,params?:any[]):Promise<{rows:any[],rowCount:number}>; export function withTransaction<T>(callback:()=>Promise<T>):Promise<T>;',
    'auth-repository.d.ts': 'export function writeAudit(event:any):Promise<void>;',
    'netsuite.d.ts': 'export function activeNetSuiteLocationDirectory():Promise<any[]>; export function fetchReturnRestockingFeeFromNetSuite():Promise<{itemId:number,percent:number}>;'
  };
  for (const [file, content] of Object.entries(declarations)) fs.writeFileSync(`${typeRoot}/src/${file}`, content);
  run('types', [path.resolve('node_modules/typescript/bin/tsc'), '--allowJs', '--checkJs', '--strict', 'false', '--noEmit',
    '--skipLibCheck', '--types', 'node', '--target', 'es2023', '--module', 'nodenext', ...typed], { cwd: typeRoot });
} finally { fs.rmSync(typeRoot, { recursive: true, force: true }); }

run('reverse-order', [...tests, ...acceptance.toReversed()]);
run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', ...files.map(file => `--include=${file}`),
  `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`, '--reporter=json-summary', '--reporter=json',
  'node', 'tools/return-enhancements-checks.mjs']);
const mutants = [
  ['overwrite-description', 'src/return-credit-memo.js', 'line.kind === "stock" && !(Number(intent.version) >= 5)', 'line.kind === "stock"', acceptance[0], 'D2'],
  ['fee-description', 'src/return-accounting.js', 'Number(intent.version) >= 5 ? {}', 'false ? {}', acceptance[0], 'D2'],
  ['unbound-intent', 'src/return-credit-memo-adjustment.js', '!isDeepStrictEqual(request.baseIntent, batch.intent_snapshot)', 'false', acceptance[0], 'A2'],
  ['wrong-cm', 'src/return-credit-memo-adjustment.js', 'request.creditMemoId !== Number(batch.netsuite_transaction_id)', 'false', acceptance[0], 'A2'],
  ['ignore-amount', 'src/return-credit-memo-adjustment.js', 'Number(actual).toFixed(2) !== Number(expected).toFixed(2)', 'false', acceptance[0], 'A3'],
  ['unsigned-correction', 'src/return-credit-memo-adjustment.js', "AND e.status='succeeded'", '', acceptance[1], 'A6'],
  ['skip-adjusted-verification', 'src/return-batch-ra-service.js', '...verificationIntent, netSuiteTransactionId: transactionId', '...batch.intent_snapshot, netSuiteTransactionId: transactionId', acceptance[1], 'A5']
];
const mutantRoot = path.resolve(output, 'mutant');
try {
  for (const dir of ['src', 'public', 'test/support']) fs.cpSync(dir, `${mutantRoot}/${dir}`, { recursive: true });
  for (const file of acceptance) {
    fs.mkdirSync(path.dirname(`${mutantRoot}/${file}`), { recursive: true }); fs.copyFileSync(file, `${mutantRoot}/${file}`);
  }
  fs.copyFileSync('package.json', `${mutantRoot}/package.json`);
  fs.symlinkSync(path.resolve('node_modules'), `${mutantRoot}/node_modules`, 'dir');
  for (const [name, file, original, replacement, testFile, pattern] of mutants) {
    const target = `${mutantRoot}/${file}`; const source = fs.readFileSync(target, 'utf8');
    assert.ok(source.includes(original), name); fs.writeFileSync(target, source.replace(original, replacement));
    try { run(`mutation-${name}`, [...tests, '--test-name-pattern', pattern, testFile], { cwd: mutantRoot, mutant: true }); }
    finally { fs.writeFileSync(target, source); }
  }
  // The pricing property alone must reject a corrupted approved rate.
  const target = `${mutantRoot}/src/return-credit-memo-adjustment.js`; const source = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, source.replace('line.rate = change.rate;', 'line.rate = change.rate + 1;'));
  run('mutation-property-rate', [...tests, '--test-name-pattern', 'A4', acceptance[0]], { cwd: mutantRoot, mutant: true });
} finally { fs.rmSync(mutantRoot, { recursive: true, force: true }); }
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const coverage = JSON.parse(fs.readFileSync(`${output}/coverage/coverage-summary.json`));
const suites = JSON.parse(fs.readFileSync('test-artifacts/return-enhancements/suites.json'));
fs.writeFileSync('test-artifacts/return-cm-description-validation.json', JSON.stringify({ passed: true, sourceHashes,
  layers, suites, mutantsKilled: mutants.length + 1, coverage, node: process.version, dependenciesAdded: 0 }, null, 2));
console.log(JSON.stringify({ passed: true, suites, mutantsKilled: mutants.length + 1, coverage: coverage.total }));
