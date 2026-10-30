import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const output = path.resolve('test-artifacts/return-enhancements');
fs.mkdirSync(output, { recursive: true });
const files = JSON.parse(fs.readFileSync('tools/return-enhancements-files.json', 'utf8'));
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const acceptance = ['test/mbt/unit/return-enhancements.test.js', 'test/mbt/unit/return-enhancements-ui.test.js',
  'test/mbt/integration/return-enhancements.test.js'];
const nodeTests = ['--test', '--test-concurrency=1'];
const layers = {};
function run(name, args, { cwd = process.cwd(), red = false, timeout = 240000 } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 25e6 });
  const text = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(output, `${name}.log`), text);
  assert.ifError(result.error);
  if (red) { assert.notEqual(result.status, 0, `${name}: mutant survived`); }
  else { assert.equal(result.status, 0, `${name}:\n${text.slice(-14000)}`); }
  layers[name] = { passed: true, ...(red ? { mutantKilled: true } : {}),
    summary: text.match(/^# (tests|pass|fail|skipped).*$/gm) || [] };
  console.log(`${name}: ${red ? 'killed' : 'passed'}${layers[name].summary.length ? ' ' + layers[name].summary.join('; ') : ''}`);
  return text;
}

const lintFiles = ['src/return-accounting.js', 'src/return-automatic-notifications.js', 'src/return-credit-memo.js',
  'public/return-notifications.js', ...acceptance, ...fs.readdirSync('tools').filter(file => /^return-enhancements.*\.mjs$/.test(file)).map(file => `tools/${file}`)];
run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/return-enhancements-eslint.config.mjs', '--max-warnings=0', ...lintFiles]);
for (const file of files.filter(name => name.endsWith('.js'))) { run(`syntax-${path.basename(file)}`, ['--check', file]); }
const findings = [...files, ...acceptance].flatMap(file => scanTextForSecrets(fs.readFileSync(file, 'utf8'), file));
assert.deepEqual(findings, []);
layers.secrets = { passed: true, scannedFiles: files.length + acceptance.length, dependenciesAdded: 0 };
console.log('secret scan: passed; dependencies added: 0');

// Check the domain modules against small, explicit declarations for existing
// I/O boundaries; importing the entire untyped server is a separate baseline.
const typeRoot = path.join(output, 'types');
try {
  fs.mkdirSync(path.join(typeRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(typeRoot, 'public'), { recursive: true });
  fs.writeFileSync(path.join(typeRoot, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(path.resolve('node_modules'), path.join(typeRoot, 'node_modules'), 'dir');
  const typed = ['return-accounting.js', 'return-credit-memo.js', 'return-automatic-notifications.js', 'return-batch-ra-domain.js'];
  for (const file of typed) { fs.copyFileSync(`src/${file}`, path.join(typeRoot, 'src', file)); }
  for (const file of ['special-stock-pricing.js', 'special-stock-calendar.js']) { fs.copyFileSync(`public/${file}`, path.join(typeRoot, 'public', file)); }
  const declarations = {
    'db.d.ts': 'export function query(sql:string,params?:any[]):Promise<{rows:any[],rowCount:number}>; export function afterTransactionCommit(callback:()=>any):boolean;',
    'netsuite.d.ts': 'export function activeNetSuiteLocationDirectory():Promise<any[]>; export function fetchReturnRestockingFeeFromNetSuite():Promise<{itemId:number,percent:number}>;',
    'return-netsuite.d.ts': 'export function fetchReturnCustomerFromNetSuite(id:any,options?:{force?:boolean}):Promise<any>;',
    'return-notification-domain.d.ts': 'export function normalizeReturnRecipient(value:unknown):{channel:string,recipient:string};',
    'return-notification-service.d.ts': 'export const returnNotifications:{send(input:any):Promise<{status:string}>};'
  };
  for (const [file, declaration] of Object.entries(declarations)) { fs.writeFileSync(path.join(typeRoot, 'src', file), declaration); }
  run('types', [path.resolve('node_modules/typescript/bin/tsc'), '--allowJs', '--checkJs', '--strict', 'false', '--noEmit',
    '--skipLibCheck', '--types', 'node', '--target', 'es2023', '--module', 'nodenext', ...typed.map(file => `src/${file}`)], { cwd: typeRoot });
} finally { fs.rmSync(typeRoot, { recursive: true, force: true }); }

if (process.argv.includes('--static-only')) { console.log('Static checks passed.'); process.exit(0); }
run('suites', ['tools/return-enhancements-checks.mjs']);
for (const [index, file] of acceptance.toReversed().entries()) { run(`acceptance-order-${index}`, [...nodeTests, file]); }

run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--include=src/return-accounting.js',
  '--include=src/return-automatic-notifications.js', '--include=src/return-credit-memo.js',
  '--include=src/return-batch-ra-domain.js', '--include=src/return-batch-ra-service.js',
  `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`, '--reporter=text', '--reporter=json', '--reporter=json-summary',
  'node', 'tools/return-enhancements-checks.mjs']);
const coverage = JSON.parse(fs.readFileSync(path.join(output, 'coverage/coverage-summary.json'), 'utf8'));

const mutants = [
  ['fee-sign', 'src/return-accounting.js', 'rate: specialDiscountLineAmount(', 'rate: -specialDiscountLineAmount(', acceptance[0], 'E6 generated'],
  ['parent-location', 'src/return-accounting.js', 'isQualityReturnLine(line) ? Number(children[0].id) : intent.receivingLocationId', 'intent.receivingLocationId', acceptance[2], 'E7 each'],
  ['custom-price', 'src/return-credit-memo.js', "{ price: { id: '-1' } }", '{}', acceptance[0], 'E10'],
  ['unknown-delivery-retry', 'src/return-automatic-notifications.js', "return result.status === 'sending' ? 'uncertain' : result.status;", "return ['sending','uncertain'].includes(result.status) ? 'failed' : result.status;", acceptance[2], 'E5 uncertain'],
  ['no-photo-admission', 'src/return-repository.js', 'if (hasStock && stockReturnType === "normal" && !stockPhotos.length)', 'if (false)', acceptance[2], 'E3 missing'],
  ['historical-pallet-fallback', 'src/return-netsuite.js', 'if (endpoint) {', 'if (false && endpoint) {', acceptance[2], 'E4 stock lookup']
];
const mutantRoot = path.join(output, 'mutant');
try {
  for (const directory of ['src', 'public', 'test/support']) { fs.cpSync(directory, path.join(mutantRoot, directory), { recursive: true }); }
  for (const file of acceptance) {
    fs.mkdirSync(path.dirname(path.join(mutantRoot, file)), { recursive: true });
    fs.copyFileSync(file, path.join(mutantRoot, file));
  }
  fs.copyFileSync('package.json', path.join(mutantRoot, 'package.json'));
  fs.symlinkSync(path.resolve('node_modules'), path.join(mutantRoot, 'node_modules'), 'dir');
  for (const [name, file, original, replacement, testFile, pattern] of mutants) {
    const destination = path.join(mutantRoot, file);
    const source = fs.readFileSync(destination, 'utf8');
    assert.ok(source.includes(original), `Missing mutation anchor: ${name}`);
    fs.writeFileSync(destination, source.replace(original, replacement));
    try { run(`mutation-${name}`, [...nodeTests, '--test-name-pattern', pattern, testFile], { cwd: mutantRoot, red: true }); }
    finally { fs.writeFileSync(destination, source); }
  }
} finally { fs.rmSync(mutantRoot, { recursive: true, force: true }); }

if (process.env.PLAYWRIGHT_BROWSERS_PATH) { run('browser', ['tools/return-enhancements-browser.mjs']); }
else { throw new Error('Final gauntlet requires the standard e2e image and Chromium'); }
const suites = JSON.parse(fs.readFileSync(path.join(output, 'suites.json'), 'utf8'));
const versions = Object.fromEntries(['typescript', 'eslint', 'c8', 'fast-check', '@playwright/test']
  .map(name => [name, JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]));
const report = { passed: true, node: process.version, versions, suites, layers, mutantsKilled: mutants.length,
  coverage: Object.fromEntries(Object.entries(coverage).map(([file, value]) => [file === 'total' ? file : path.basename(file), value])), sourceHashes };
fs.writeFileSync('test-artifacts/return-enhancements-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, suites, mutantsKilled: mutants.length, coverage: coverage.total, sourceFiles: files.length }, null, 2));
