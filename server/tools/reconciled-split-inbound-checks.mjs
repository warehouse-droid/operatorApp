import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { regression } from './split-inbound-completion-suite.mjs';
import { scanPaths } from '../test/support/scan-diff-secrets.mjs';

const artifact = 'test-artifacts/reconciled-split-inbound';
const helper = 'src/smart-scm-split-inbound-sql.js';
const focused = ['test/mbt/integration/reconciled-split-inbound.test.js', 'test/mbt/integration/split-inbound-completion.test.js'];
const maintenance = 'test/mbt/integration/reconciled-split-inbound-refresh.test.js';
function run(args, log, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(`${artifact}/${log}.log`, output);
  return { status: result.status, output };
}
const failures = output => [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
const mode = process.argv[2];
if (mode === 'baseline' || mode === 'suite') {
  const groups = [['normal', [...focused.slice(mode === 'baseline' ? 1 : 0), ...regression]],
    ['reversed', [...regression].reverse().concat([...focused.slice(mode === 'baseline' ? 1 : 0)].reverse())]];
  const summary = [];
  for (const [order, files] of groups) {
    const result = run(['--test', '--test-concurrency=1', ...files], `${mode}-${order}`);
    const failed = failures(result.output);
    if (mode === 'baseline') fs.writeFileSync(`${artifact}/baseline-${order}.json`, JSON.stringify(failed));
    else assert.deepEqual(failed, JSON.parse(fs.readFileSync(`${artifact}/baseline-${order}.json`, 'utf8')));
    summary.push({ order, failures: failed, counts: result.output.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)) });
  }
  fs.writeFileSync(`${artifact}/${mode}.json`, JSON.stringify(summary, null, 2));
  if (mode === 'suite') {
    const checked = run(['--test', maintenance], 'refresh');
    assert.equal(checked.status, 0, checked.output);
  }
  console.log(JSON.stringify(summary));
} else if (mode === 'static') {
  const files = [helper, focused[0], maintenance, 'tools/reconciled-split-inbound-refresh.mjs', 'tools/reconciled-split-inbound-audit.mjs'];
  for (const file of files) assert.equal(run(['--check', file], `syntax-${path.basename(file)}`).status, 0);
  const type = run(['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
    '--module', 'nodenext', '--target', 'ES2022', helper], 'types');
  assert.equal(type.status, 0, type.output);
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
    files: ['**/*.{js,mjs}'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { process: 'readonly', performance: 'readonly', console: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'error', 'no-unreachable': 'error', 'eqeqeq': 'error' }
  }] });
  const lint = (await eslint.lintFiles(files)).flatMap(row => row.messages);
  assert.deepEqual(lint, []);
  const complexity = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.js'], rules: { complexity: ['error', 12] } }] });
  assert.deepEqual((await complexity.lintFiles(helper))[0].messages, []);
  assert.deepEqual(await scanPaths(files), []);
  const coverage = run(['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false', '--reporter=json', '--reporter=json-summary',
    `--temp-directory=${artifact}/c8-tmp`, `--report-dir=${artifact}/coverage`, `--include=${helper}`, 'node', '--test', '--test-concurrency=1', ...focused], 'coverage');
  assert.equal(coverage.status, 0, coverage.output);
  const summary = JSON.parse(fs.readFileSync(`${artifact}/coverage/coverage-summary.json`, 'utf8')).total;
  assert.equal(summary.lines.pct, 100);
  const result = { node: process.version, typescript: JSON.parse(fs.readFileSync('node_modules/typescript/package.json')).version,
    lint, types: 'passed', secrets: [], coverage: summary, sha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex') };
  fs.writeFileSync(`${artifact}/static.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else if (mode === 'mutations') {
  const original = fs.readFileSync(helper, 'utf8');
  const mutations = [
    ['ignore-reconciliation', 'SELECT SUM(receipt.quantity)', 'SELECT SUM(0)'],
    ['include-inactive', 'AND receipt.active = true', 'AND true'],
    ['count-fulfillments', "AND receipt.progress_kind = 'received'", 'AND true'],
    ['consume-other-lines', 'AND receipt_ledger.split_line_id = ${line}.id', 'AND true'],
    ['add-overlapping-receipts', 'COALESCE(${line}.netsuite_received_qty, 0),', 'COALESCE(${line}.netsuite_received_qty, 0) +']
  ];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciled-inbound-mutants-'));
  const results = [];
  try {
    for (const folder of ['src', 'test', 'public']) fs.cpSync(folder, path.join(scratch, folder), { recursive: true });
    fs.copyFileSync('package.json', path.join(scratch, 'package.json'));
    fs.symlinkSync(path.resolve('node_modules'), path.join(scratch, 'node_modules'));
    for (const [name, before, after] of mutations) {
      assert.equal(original.split(before).length, 2, name);
      fs.writeFileSync(path.join(scratch, helper), original.replace(before, after));
      const result = run(['--test', ...focused], `mutant-${name}`, { cwd: scratch });
      const killed = result.status !== 0 && /ERR_ASSERTION|Property failed/.test(result.output);
      results.push({ name, killed, failures: failures(result.output) });
      assert.ok(killed, name);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  fs.writeFileSync(`${artifact}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} else throw new Error('Expected baseline, suite, static, or mutations');
