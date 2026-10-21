import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['src/operator-netsuite-receipt-charges.js', 'src/operator-netsuite-posting-netsuite-adapter.js',
  'src/operator-netsuite-posting-service.js'];
const report = { versions: { node: process.version }, source: {}, types: {}, lint: {}, mutations: [] };
for (const name of ['c8', 'eslint', 'typescript', 'fast-check']) {
  report.versions[name] = JSON.parse(readFileSync(`/app/node_modules/${name}/package.json`, 'utf8')).version;
}
for (const file of files) {
  report.source[file] = createHash('sha256').update(readFileSync(`/app/${file}`)).digest('hex');
}

function run(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd: '/app', maxBuffer: 25000000,
    timeout: 120000, ...options });
}
function diagnostics(root, targets) {
  const result = run(['/app/node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck',
    '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', ...targets.map(file => `${root}/${file}`)],
  { cwd: root });
  writeFileSync(`/evidence/types-${root === '/app' ? 'candidate' : 'baseline'}.log`, result.stdout + result.stderr);
  const errors = result.stdout.split('\n').filter(line => /error TS\d+/.test(line));
  assert.ok([0, 1, 2].includes(result.status) && !result.error, result.stderr);
  assert.ok(result.status === 0 || errors.length > 0, 'Compiler failed without diagnostics');
  return errors.map(line => line.replace(/\(\d+,\d+\)/, ''));
}
const baseline = diagnostics('/baseline', files.slice(1));
const current = diagnostics('/app', files);
const remaining = [...baseline];
const newErrors = current.filter(line => {
  const index = remaining.indexOf(line);
  if (index < 0) { return true; }
  remaining.splice(index, 1); return false;
});
report.types = { baseline: baseline.length, candidate: current.length, newErrors };
console.log(JSON.stringify({ types: report.types }));
assert.deepEqual(newErrors, []);
function lintDiagnostics(root, targets) {
  const lint = run(['/app/node_modules/eslint/bin/eslint.js', '--config', '/app/tools/receipt-extra-charges/eslint.config.mjs',
    '--format=json', '--max-warnings=0', ...targets], { cwd: root });
  writeFileSync(`/evidence/lint-${root === '/app' ? 'candidate' : 'baseline'}.log`, lint.stdout + lint.stderr);
  assert.ok([0, 1].includes(lint.status), lint.stderr);
  return JSON.parse(lint.stdout).flatMap(row => row.messages.map(message => ({
    file: row.filePath.slice(root.length + 1), message: message.message, rule: message.ruleId, severity: message.severity })));
}
const priorLint = lintDiagnostics('/baseline', files.slice(1));
const nextLint = lintDiagnostics('/app', files);
const newLint = nextLint.filter(row => !priorLint.some(prior => JSON.stringify(prior) === JSON.stringify(row)));
report.lint = { baseline: priorLint, candidate: nextLint, newErrors: newLint };
console.log(JSON.stringify({ lint: report.lint }));
assert.deepEqual(newLint, []);

const coverage = run(['node_modules/c8/bin/c8.js', 'report', '--temp-directory=/evidence/coverage/raw',
  '--report-dir=/evidence/coverage/report', '--reporter=json', '--reporter=json-summary',
  ...files.map(file => `--include=${file}`)]);
writeFileSync('/evidence/coverage-report.log', coverage.stdout + coverage.stderr);
assert.equal(coverage.status, 0);
const coverageData = JSON.parse(readFileSync('/evidence/coverage/report/coverage-final.json', 'utf8'));
const changed = JSON.parse(readFileSync('/evidence/changed-lines.json', 'utf8'));
report.coverage = {};
for (const file of files) {
  const data = coverageData[`/app/${file}`];
  assert.ok(data, `Missing coverage: ${file}`);
  const lines = {};
  for (const [id, statement] of Object.entries(data.statementMap)) {
    lines[statement.start.line] = Math.max(lines[statement.start.line] || 0, data.s[id]);
  }
  const executable = changed[file].filter(line => Object.hasOwn(lines, line));
  const uncovered = executable.filter(line => lines[line] === 0);
  const branches = Object.entries(data.branchMap).filter(([, branch]) =>
    changed[file].some(line => line >= branch.loc.start.line && line <= branch.loc.end.line));
  report.coverage[file] = { changedExecutable: executable.length, changedCovered: executable.length - uncovered.length,
    uncovered, branches: branches.flatMap(([id]) => data.b[id]).length,
    branchesCovered: branches.flatMap(([id]) => data.b[id]).filter(count => count > 0).length };
  assert.deepEqual(uncovered, [], file);
}
console.log(JSON.stringify({ coverage: report.coverage }));

const temporary = '/tmp/receipt-charge-mutations';
mkdirSync(`${temporary}/tools`, { recursive: true });
cpSync('/app/src', `${temporary}/src`, { recursive: true });
cpSync('/app/tools/receipt-extra-charges', `${temporary}/tools/receipt-extra-charges`, { recursive: true });
cpSync('/app/package.json', `${temporary}/package.json`);
symlinkSync('/app/node_modules', `${temporary}/node_modules`);
symlinkSync('/app/public', `${temporary}/public`);
const helper = `${temporary}/${files[0]}`;
const original = readFileSync(helper, 'utf8');
const mutations = [
  ['charge type', "line.itemType === 'OthCharge' && ", ''],
  ['purchase subtype', "line.itemSubtype === 'Purchase' && ", ''],
  ['inventory accrual', " && line.generateAccruals === false", ''],
  ['source PO', 'positiveId(source.id) !== positiveId(step.sourceNetSuiteId)', 'false'],
  ['source charge type', "expected.itemType !== 'OthCharge' || ", ''],
  ['ordered quantity bound', 'quantity > ordered + 0.000001', 'false'],
  ['receipt amount', 'Math.abs(amount - quantity * rate) > 0.00500001', 'false'],
  ['receipt rate', 'Math.abs(actualRate - rate) > 0.000001', 'false'],
  ['receipt location', 'const location = positiveId(expected.locationId);',
    'const location = positiveId(actual.location?.id ?? actual.location);'],
  ['unnecessary source reads', 'return additionalCharges(step, record).length > 0;', 'return true;'],
  ['always reject valid charges', 'return { ...verifyOperatorNetSuitePostingRecord(verificationStep, record), additionalPurchaseCharges };',
    "throw mismatch('was rejected');"],
  ['accept all unverified charges', 'const additionalPurchaseCharges = additionalCharges(step, record).map(actual => verifiedCharge(step, actual, source));',
    "return { id: Number(record.id), transactionRef: record.tranId };\n/* mutation */ const additionalPurchaseCharges = [];"]
];
try {
  for (const suite of ['unit.test.mjs', 'property.test.mjs']) {
    const control = run(['--test', `${temporary}/tools/receipt-extra-charges/${suite}`]);
    writeFileSync(`/evidence/mutation-control-${suite}.log`, control.stdout + control.stderr);
    assert.equal(control.status, 0, `Unmodified mutation control: ${suite}`);
  }
  for (const [name, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, name);
    writeFileSync(helper, original.replace(before, after));
    for (const suite of ['unit.test.mjs', 'property.test.mjs']) {
      const result = run(['--test', `${temporary}/tools/receipt-extra-charges/${suite}`]);
      writeFileSync(`/evidence/mutant-${name.replaceAll(' ', '-')}-${suite}.log`, result.stdout + result.stderr);
      assert.equal(result.status, 1, `${name} survived ${suite}`);
      assert.match(result.stdout, /not ok/);
      assert.doesNotMatch(result.stdout + result.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/);
      const killedBy = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
      report.mutations.push({ name, suite, killed: true, killedBy });
      console.log(JSON.stringify({ mutant: name, suite, killed: true }));
    }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
writeFileSync('/evidence/quality-results.json', JSON.stringify(report, null, 2));
