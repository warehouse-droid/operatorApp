import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import coverage from 'istanbul-lib-coverage';
import { suites } from './special-quote-breakdown-tests.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const out = 'test-artifacts', files = JSON.parse(await readFile('tools/special-quote-breakdown-files.json', 'utf8'));
const unit = 'test/mbt/unit/special-quote-breakdown.test.js';
const units = ['test/mbt/unit/special-quote-discount-summary.test.js', unit];
const layers = [], hash = value => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')])));
const sourceHashes = Object.fromEntries(files.map(file => [file, hash(sources[file])]));

async function run(name, args, options = {}, expected = 0) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 20000000, timeout: 60000, ...options });
  await writeFile(`${out}/${name}.log`, (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.status, expected, `${name}: ${result.stdout}${result.stderr}`);
  layers.push({ name, exitCode: 0 });
  return result;
}

for (const file of [...files, ...units, 'tools/special-quote-breakdown-tests.mjs']) {
  await run('syntax-' + file.replaceAll('/', '-'), ['--check', file]);
}
const lint = new ESLint({ overrideConfigFile: 'tools/special-quote-breakdown-eslint.config.mjs' });
const messages = async (source, file) => (await lint.lintText(source, { filePath: file }))[0].messages
  .map(({ ruleId, severity, message }) => JSON.stringify({ ruleId, severity, message }));
const lintReport = { existing: 0, newDiagnostics: [] };
for (const file of files) {
  const allowed = await messages(await readFile(`${out}/before/${file}`, 'utf8'), file);
  for (const message of await messages(sources[file], file)) {
    const index = allowed.indexOf(message);
    if (index < 0) { lintReport.newDiagnostics.push({ file, message }); }
    else { allowed.splice(index, 1); lintReport.existing++; }
  }
}
for (const file of [...units, 'tools/special-quote-breakdown-tests.mjs', 'tools/special-quote-breakdown-check.mjs']) {
  for (const message of await messages(await readFile(file, 'utf8'), file)) { lintReport.newDiagnostics.push({ file, message }); }
}
await writeFile(`${out}/lint.json`, JSON.stringify(lintReport, null, 2));
assert.deepEqual(lintReport.newDiagnostics, []);
layers.push({ name: 'lint', exitCode: 0 });

const temporary = await mkdtemp(join(tmpdir(), 'quote-discount-check-'));
const mutants = [];
let typeReport;
try {
  for (const folder of ['src', 'public', 'test']) { await cp(resolve(folder), join(temporary, folder), { recursive: true }); }
  await cp('package.json', join(temporary, 'package.json'));
  await symlink(resolve('node_modules'), join(temporary, 'node_modules'), 'dir');
  const types = ['node_modules/typescript/bin/tsc', '--allowJs', 'true', '--checkJs', 'true', '--noEmit', 'true',
    '--strict', 'false', '--skipLibCheck', 'true', '--target', 'ES2023', '--module', 'NodeNext', '--pretty', 'false', ...files];
  const diagnose = cwd => {
    const result = spawnSync(process.execPath, types, { cwd, encoding: 'utf8', maxBuffer: 20000000, timeout: 60000 });
    assert(result.status === 0 || [1, 2].includes(result.status) && /error TS\d+/.test(result.stdout),
      `TypeScript exit ${result.status}: ${result.stdout}${result.stderr}`);
    return (result.stdout + result.stderr).split('\n').filter(line => line.trim())
      .map(line => line.replaceAll(temporary, '').replace(/\(\d+,\d+\)/g, '(position)'));
  };
  for (const file of files) { await cp(`${out}/before/${file}`, join(temporary, file)); }
  const allowed = diagnose(temporary), current = diagnose(resolve('.'));
  typeReport = { existingDiagnostics: allowed.length, newDiagnostics: [] };
  for (const message of current) {
    const index = allowed.indexOf(message);
    if (index < 0) { typeReport.newDiagnostics.push(message); }
    else { allowed.splice(index, 1); }
  }
  await writeFile(`${out}/types.json`, JSON.stringify(typeReport, null, 2));
  assert.deepEqual(typeReport.newDiagnostics, []);
  layers.push({ name: 'types', exitCode: 0 });
  for (const file of files) { await writeFile(join(temporary, file), sources[file]); }
  const cases = [
    ['item amount is already discounted', 'line.grossAmountMinor??line.amountMinor', 'line.amountMinor'],
    ['before-discount subtotal shows net', "['Subtotal before discount',totals.grossSubtotalMinor,false]",
      "['Subtotal before discount',totals.subtotalMinor,false]"],
    ['discount deducted twice from displayed net', "['Subtotal after discount',totals.subtotalMinor,false]",
      "['Subtotal after discount',totals.subtotalMinor-totals.discountMinor,false]"]
  ];
  const file = 'src/field-sales/company-pdf.js';
  for (const [i, [name, needle, replacement]] of cases.entries()) {
    assert.equal(sources[file].split(needle).length, 2, name);
    await writeFile(join(temporary, file), sources[file].replace(needle, replacement));
    const runs = [];
    for (const propertiesOnly of [false, true]) {
      const result = await run(`mutant-${i}-${propertiesOnly}`, ['--test',
        ...(propertiesOnly ? ['--test-name-pattern=property:'] : []), ...units], { cwd: temporary }, 1);
      assert.match(result.stdout, /not ok/);
      assert.doesNotMatch(result.stdout, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      runs.push({ propertiesOnly, killed: true });
    }
    await writeFile(join(temporary, file), sources[file]);
    mutants.push({ name, runs });
  }
  await run('restored-unit', ['--test', ...units], { cwd: temporary });
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const ordered = [...suites, unit];
let state = 20260930;
for (let i = ordered.length - 1; i > 0; i--) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const j = state % (i + 1);
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
}
const shuffled = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...ordered],
  { encoding: 'utf8', maxBuffer: 20000000 });
await writeFile(`${out}/shuffle.log`, shuffled.stdout + shuffled.stderr);
const failures = [...shuffled.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
const baseline = JSON.parse(await readFile(`${out}/baseline-tests.json`, 'utf8'));
assert(shuffled.status === 0 || shuffled.status === 1 && failures.length > 0);
assert.deepEqual(failures.filter(name => !baseline.failures.includes(name)), []);
layers.push({ name: 'suite-health', exitCode: 0 });

const measured = coverage.createCoverageMap(JSON.parse(await readFile(`${out}/coverage/coverage-final.json`, 'utf8')));
const changed = JSON.parse(await readFile(`${out}/changed-source-lines.json`, 'utf8'));
const report = { covered: 0, total: 0, uncovered: [], missingFiles: [], branches: { covered: 0, total: 0, uncovered: [] } };
for (const [file, added] of Object.entries(changed)) {
  if (!measured.files().includes(resolve(file))) { report.missingFiles.push(file); continue; }
  const entry = measured.fileCoverageFor(resolve(file)), lines = entry.getLineCoverage();
  for (const number of added) {
    if (!Object.hasOwn(lines, number)) { continue; }
    report.total++;
    if (lines[number]) { report.covered++; } else { report.uncovered.push(`${file}:${number}`); }
  }
  for (const [id, branch] of Object.entries(entry.branchMap)) {
    if (!added.includes(branch.line)) { continue; }
    for (const count of entry.b[id]) {
      report.branches.total++;
      if (count) { report.branches.covered++; } else { report.branches.uncovered.push(`${file}:${branch.line}`); }
    }
  }
}
await writeFile(`${out}/changed-lines.json`, JSON.stringify(report, null, 2));
assert.deepEqual(report.missingFiles, []);
assert.deepEqual(report.uncovered, []);
assert.deepEqual(report.branches.uncovered, []);
layers.push({ name: 'changed-line-coverage', exitCode: 0 });
const dependencyBaseline = JSON.parse(await readFile(`${out}/baseline.json`, 'utf8'));
assert.equal(hash(await readFile('package.json')), dependencyBaseline.packageSha256);
const patch = await readFile('test/special-quote-breakdown.changes.patch', 'utf8');
for (const addedLine of patch.split('\n').filter(entry => entry.startsWith('+') && !entry.startsWith('+++'))) {
  assert.doesNotMatch(addedLine, /-----BEGIN|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9_-]{20,}|process\.env|child_process|fetch\(/);
}
layers.push({ name: 'dependencies-and-capabilities', exitCode: 0 });
const toolchain = { node: process.version };
for (const name of ['fast-check', 'c8', 'eslint', 'typescript', 'pdfkit']) {
  toolchain[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
}
const result = { sourceHashes, sourceTreeSha256: hash(JSON.stringify(sourceHashes)), layers, mutants, coverage: report,
  lint: lintReport, types: typeReport, toolchain, dependenciesChanged: false, shuffleSeed: 20260930, suiteOrder: ordered };
await writeFile(`${out}/checks.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ newLintDiagnostics: 0, newTypeDiagnostics: 0, mutants: mutants.length, coverage: report }));
