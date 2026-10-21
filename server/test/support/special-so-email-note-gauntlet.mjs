import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import coverage from 'istanbul-lib-coverage';

const root = process.cwd();
const out = path.join(root, 'test-artifacts/special-so-email-note-20261009');
const targets = ['src/special-stock-request-netsuite.js', 'src/special-stock-request-service.js', 'src/special-stock-request-repository.js'];
const focused = ['test/mbt/unit/special-stock-request-netsuite.red.test.js',
  'test/mbt/unit/special-stock-request-service.red.test.js',
  'test/mbt/property/special-so-email-note.property.test.js',
  'test/mbt/integration/special-order-rejection-unlock.test.js',
  'test/mbt/property/special-order-rejection.property.test.js'];
const baselineFailures = ['multi-line case transitions atomically from Sales to SCM and back to an exact SO draft',
  'Sales and SCM Special tabs are real feature-gated interfaces'];

if (process.env.MBT_TEST_ISOLATED !== '1' || process.env.NETSUITE_DIRECT_ACCESS_ENABLED !== 'false') {
  throw new Error('Only run this gauntlet in the isolated Compose test environment.');
}
await fs.mkdir(out, { recursive: true });
await fs.rm(path.join(out, 'coverage'), { recursive: true, force: true });
await fs.rm(path.join(out, 'result.json'), { force: true });

async function run(name, args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) { throw result.error; }
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await fs.writeFile(path.join(out, `${name}.log`), output);
  return { status: result.status, output };
}

function requirePass(result, label) {
  assert.equal(result.status, 0, `${label} failed; inspect its evidence log.`);
}

function verifySuite(result) {
  const failures = [...result.output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  assert.deepEqual(failures, [...baselineFailures].sort(), 'Full suite has a new failure or changed baseline.');
  const count = label => Number(result.output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1]);
  assert.equal(count('fail'), baselineFailures.length);
  assert.ok(count('tests') > 65);
  return { tests: count('tests'), passed: count('pass'), baselineFailures: failures, newFailures: 0 };
}

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const baseSuite = pkg.scripts['test:special-stock-request'].split(/\s+/).filter(value => value.startsWith('test/'));
const extra = ['test/mbt/property/special-so-email-note.property.test.js', 'test/mbt/unit/special-po-so-note.test.js',
  'test/mbt/unit/special-stock-rest-units.test.js', 'test/mbt/unit/special-po-line-discount.test.js',
  'test/mbt/unit/special-delivery-fee.test.js', 'test/mbt/unit/special-workflow-adjustments.test.js',
  ...focused.slice(3)];
const suites = [...baseSuite, ...extra];
const suite = verifySuite(await run('suite', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  ...targets.map(file => `--include=${file}`), '--reporter=text', '--reporter=json', '--reporter=json-summary',
  '--temp-directory=/tmp/special-so-note-coverage', `--report-dir=${out}/coverage`,
  process.execPath, '--test', '--test-concurrency=1', ...suites]));
console.log(JSON.stringify({ suite }));

const lintFiles = [...targets, ...focused, 'test/support/special-so-email-note-gauntlet.mjs'];
requirePass(await run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'eslint.mbt.config.js',
  '--max-warnings=0', ...lintFiles]), 'Lint');
for (const [index, file] of targets.entries()) {
  requirePass(await run(`syntax-${index}`, ['--check', file]), `Syntax ${file}`);
}
requirePass(await run('secrets', ['test/support/scan-diff-secrets.mjs', ...lintFiles]), 'Secret scan');

const map = coverage.createCoverageMap(JSON.parse(await fs.readFile(path.join(out, 'coverage/coverage-final.json'), 'utf8')));
const changedLines = [];
for (const file of targets) {
  const diff = spawnSync('diff', ['-U0', path.join('/app/note-baseline', path.basename(file)), file], { encoding: 'utf8' });
  assert.ok(diff.status === 0 || diff.status === 1);
  const hits = map.fileCoverageFor(path.join(root, file)).getLineCoverage();
  let line = 0;
  for (const text of diff.stdout.split('\n')) {
    const hunk = text.match(/^@@ -[^+]*\+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('-')) { continue; }
    if (text.startsWith('+')) {
      if (text.slice(1).trim() && !text.slice(1).trim().startsWith('/**')) {
        assert.ok(hits[line] > 0, `${file}:${line} is an uncovered changed line`);
        changedLines.push({ file, line, hits: hits[line] });
      }
      line += 1;
    } else if (text.startsWith(' ')) { line += 1; }
  }
}
await fs.writeFile(path.join(out, 'changed-lines.json'), JSON.stringify(changedLines, null, 2));

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'special-note-gauntlet-'));
const original = new Map();
let types;
const mutations = [];

function diagnostics(output) {
  return [...output.matchAll(/^(.+?)\(\d+,\d+\): error (TS\d+): (.+)$/gm)]
    // The added outgoing field appears inside the printed inferred object
    // shape of old missing-property diagnostics. Preserve the diagnostic's
    // file, code, and missing property; normalize only that displayed member.
    .map(match => `${match[1]} ${match[2]} ${match[3].replaceAll(' toBeEmailed: boolean;', '')}`).sort();
}

async function typecheck(name) {
  const result = await run(name, ['node_modules/typescript/lib/tsc.js', '--allowJs', '--checkJs', '--noEmit',
    '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', ...targets], scratch);
  const errors = diagnostics(result.output);
  if (result.status !== 0) { assert.ok(errors.length, `${name} failed without usable type diagnostics`); }
  return errors;
}

try {
  for (const directory of ['src', 'public']) { await fs.cp(path.join(root, directory), path.join(scratch, directory), { recursive: true }); }
  await fs.copyFile('package.json', path.join(scratch, 'package.json'));
  await fs.symlink(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'));
  for (const file of focused) {
    await fs.mkdir(path.dirname(path.join(scratch, file)), { recursive: true });
    await fs.copyFile(file, path.join(scratch, file));
  }
  for (const file of targets) {
    original.set(file, await fs.readFile(file, 'utf8'));
    await fs.copyFile(path.join('/app/note-baseline', path.basename(file)), path.join(scratch, file));
  }
  const beforeTypes = await typecheck('types-baseline');
  for (const file of targets) { await fs.writeFile(path.join(scratch, file), original.get(file)); }
  const afterTypes = await typecheck('types-candidate');
  const remaining = [...beforeTypes];
  const added = [];
  for (const diagnostic of afterTypes) {
    const index = remaining.indexOf(diagnostic);
    if (index < 0) { added.push(diagnostic); } else { remaining.splice(index, 1); }
  }
  assert.deepEqual(added, [], 'New focused type diagnostics introduced.');
  types = { baselineDiagnostics: beforeTypes.length, candidateDiagnostics: afterTypes.length,
    newDiagnostics: 0, resolvedDiagnostics: remaining.length };

  const tests = ['--test', '--test-concurrency=1', ...focused];
  requirePass(await run('focused', tests, scratch), 'Focused regressions');
  const mutants = [
    { name: 'email-enabled', file: targets[0], from: 'toBeEmailed: false,', to: 'toBeEmailed: true,', property: focused[2] },
    { name: 'so-note-dropped', file: targets[1], from: 'remarks: detail.remarks,', to: 'remarks: undefined,', property: false },
    { name: 'po-private-remark', file: targets[1], from: 'remarks: claimed.remarks,', to: 'remarks: claimed.salesInternalRemark,', property: false },
    { name: 'delivery-instructions-dropped', file: targets[0], from: '[instructions, String(draft?.remarks', to: '["", String(draft?.remarks', property: focused[2] },
    { name: 'po-so-reference-dropped', file: targets[0], from: 'salesOrderNumber ? `for ${salesOrderNumber}` : ""', to: '""', property: focused[2] },
    { name: 'server-error-retryable', file: targets[0], from: '[400, 401, 403, 404, 422]', to: '[400, 401, 403, 404, 422, 500, 503]', property: focused[4] },
    { name: 'uncertain-submission-unlocked', file: targets[2], from: '(retryable && !special[`${field}_submission_started_at`])', to: 'retryable', property: false },
    { name: 'rejected-submission-guard-retained', file: targets[2], from: '${field}_submission_started_at=NULL, ${field}_operation_error=NULL,', to: '${field}_operation_error=NULL,', property: false },
    { name: 'linked-order-unlocked', file: targets[2], from: 'if (special[`${field}_netsuite_id`]) return;', to: '', property: false }
  ];
  for (const mutant of mutants) {
    const source = original.get(mutant.file);
    assert.ok(source.includes(mutant.from), `Mutation target missing: ${mutant.name}`);
    try {
      await fs.writeFile(path.join(scratch, mutant.file), source.replaceAll(mutant.from, mutant.to));
      const result = await run(`mutant-${mutant.name}`, tests, scratch);
      assert.equal(result.status, 1, `Mutant survived: ${mutant.name}`);
      assert.match(result.output, /ERR_ASSERTION|Property failed/);
      if (mutant.property) {
        const propertyResult = await run(`property-mutant-${mutant.name}`, ['--test', mutant.property], scratch);
        assert.equal(propertyResult.status, 1, `Property suite missed: ${mutant.name}`);
      }
      mutations.push({ name: mutant.name, killed: true, propertyOnly: mutant.property ? 'killed' : 'not applicable: service or database state' });
    } finally { await fs.writeFile(path.join(scratch, mutant.file), source); }
  }
  requirePass(await run('restored-focused', tests, scratch), 'Restored source');
} finally { await fs.rm(scratch, { recursive: true, force: true }); }

const reverse = verifySuite(await run('reverse-suite', ['--test', '--test-concurrency=1', ...[...suites].reverse()]));
const hashes = {};
for (const file of targets) { hashes[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
const toolchain = { node: process.version };
for (const name of ['c8', 'eslint', 'typescript', 'fast-check']) {
  toolchain[name] = JSON.parse(await fs.readFile(`node_modules/${name}/package.json`, 'utf8')).version;
}
const result = { suite, reverse, types, changedLinesCovered: changedLines.length, mutations, hashes, toolchain,
  propertyExamples: 650, newDependencies: 0, completedAt: new Date().toISOString() };
await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
