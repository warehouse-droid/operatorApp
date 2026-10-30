import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ESLint } from 'eslint';
import base from '../eslint.mbt.config.js';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const folder = path.resolve('test-artifacts/co-correction');
const testFile = 'test/dispatch/integration/co-transfer-correction.test.js';
const codeFile = 'tools/co-10919-correction.mjs';
await mkdir(folder, { recursive: true });
async function run(command, args, cwd = process.cwd()) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => {output += chunk;});
    child.stderr.on('data', chunk => {output += chunk;});
    child.on('error', error => resolve({ code: 1, output: String(error) }));
    child.on('close', code => resolve({ code, output }));
  });
}
function report(result) {
  console.log(result.output.split('\n').filter(line => /^ℹ (tests|pass|fail)|^Isolated |^All files|co-10919-correction/.test(line)).join('\n'));
  if (result.code) {console.log(result.output.slice(-8000));}
}
const lint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ ...base[1], files: ['**/*.js', '**/*.mjs'] }] });
const files = [codeFile, testFile, 'tools/co-10919-capture.mjs', 'tools/co-10919-checks.mjs'];
for (const file of files) {
  const syntax = await run(process.execPath, ['--check', file]);
  assert.equal(syntax.code, 0, syntax.output);
  const [result] = await lint.lintText(await readFile(file, 'utf8'), { filePath: path.resolve(file) });
  assert.equal(result.errorCount + result.warningCount, 0, JSON.stringify(result.messages));
}
console.log(`Syntax/lint: ${files.length} files, 0 issues`);
const regression = await run('./node_modules/.bin/c8', ['--all=false', '--check-coverage=false', `--include=${codeFile}`,
  `--temp-directory=${folder}/v8`, `--reports-dir=${folder}/coverage`, '--reporter=text', '--reporter=json-summary',
  process.execPath, 'tools/run-co-operator-regressions.mjs', testFile, 'test/dispatch/integration/co-operator-routing.test.js']);
await writeFile(path.join(folder, 'tests.log'), regression.output);
report(regression);
assert.equal(regression.code, 0);
const coverage = JSON.parse(await readFile(path.join(folder, 'coverage/coverage-summary.json'), 'utf8'));
console.log(JSON.stringify({ correctionCoverage: coverage.total }));
assert.equal(coverage.total.lines.pct, 100);

const workspace = path.join(folder, 'mutation');
await mkdir(path.join(workspace, 'test/dispatch/integration'), { recursive: true });
await mkdir(path.join(workspace, 'test/support'), { recursive: true });
await mkdir(path.join(workspace, 'tools'), { recursive: true });
await cp('src', path.join(workspace, 'src'), { recursive: true });
for (const file of [codeFile, testFile, 'package.json', 'test/support/group-underpack-fixture.mjs']) {await cp(file, path.join(workspace, file));}
for (const name of ['node_modules', 'public', 'migrations']) {await symlink(path.resolve(name), path.join(workspace, name));}
const mutants = [
  ['remote-guard', 'assert.equal(await lookup(target.ifId), null, `${target.ifRef} still exists in NetSuite`);', 'await lookup(target.ifId);'],
  ['load-identity', "load_type='local_co_load'", "load_type='sales_order_delivery_load'"],
  ['loaded-quantity', 'SET loaded_qty=0,confirmed=false', 'SET loaded_qty=loaded_qty,confirmed=false']
];
try {
  const original = await readFile(codeFile, 'utf8');
  for (const [name, from, to] of mutants) {
    assert.equal(original.split(from).length, 2, name);
    await writeFile(path.join(workspace, codeFile), original.replace(from, to));
    const result = await run(process.execPath, ['--test', testFile], workspace);
    await writeFile(path.join(folder, `mutant-${name}.log`), result.output);
    assert.ok(result.code && result.output.includes('not ok'), `Surviving mutant ${name}`);
    console.log(`mutant ${name}: killed`);
  }
} finally {await rm(workspace, { recursive: true, force: true });}
const final = await run(process.execPath, ['tools/run-co-operator-regressions.mjs', testFile]);
report(final);
assert.equal(final.code, 0);
console.log(JSON.stringify({ node: process.version, hashes: Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(file)).digest('hex')]))) }));
