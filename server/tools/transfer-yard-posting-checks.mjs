import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, symlink, rm, mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const root = '/app', artifact = `${root}/test-artifacts/transfer-yard-posting-20261021`;
const output = `${artifact}/final`;
await mkdir(output, { recursive: true });
const files = ['src/transfer-order-posting-domain.js', 'src/transfer-order-posting-repository.js',
  'src/transfer-order-posting-service.js', 'src/operator-netsuite-posting-domain.js',
  'src/operator-netsuite-posting-targets.js', 'src/operator-netsuite-posting-admission.js',
  'src/movement-record-evidence.js', 'src/consolidation-load-posting.js'];

async function stageBaseline() {
  const temporary = await mkdtemp('/tmp/transfer-yard-baseline-');
  await cp(`${artifact}/baseline-runtime/src`, `${temporary}/src`, { recursive: true });
  await cp(`${root}/test`, `${temporary}/test`, { recursive: true });
  await cp(`${artifact}/before/test`, `${temporary}/test`, { recursive: true });
  for (const name of ['node_modules', 'public', 'contracts', 'migrations', 'test-artifacts']) {
    await symlink(`${root}/${name}`, `${temporary}/${name}`);
  }
  await mkdir(`${temporary}/tools`);
  for (const entry of await readdir(`${root}/tools`, { withFileTypes: true })) {
    if (entry.isFile()) { await cp(`${root}/tools/${entry.name}`, `${temporary}/tools/${entry.name}`); }
    else { await symlink(`${root}/tools/${entry.name}`, `${temporary}/tools/${entry.name}`); }
  }
  for (const name of ['package.json', 'tsconfig.mbt.json', 'eslint.mbt.config.js']) {
    await cp(`${root}/${name}`, `${temporary}/${name}`);
  }
  // Keep the suite entry point inside the staged tree so its relative imports
  // and test paths resolve against the baseline, while preserving tooling.
  await cp(`${root}/tools/transfer-yard-posting-suite.mjs`, `${temporary}/suite.mjs`);
  const suite = await readFile(`${temporary}/suite.mjs`, 'utf8');
  await writeFile(`${temporary}/suite.mjs`, suite.replace("'../test/support/", "'./test/support/"));
  return temporary;
}

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  assert.ok(!result.error && !result.signal, result.error?.message || result.signal);
  return { exitCode: result.status, text: (result.stdout || '') + (result.stderr || '') };
}

function failures(log) {
  return [...new Set([...log.matchAll(/^✖ (.+?) \([\d.]+ms\)$/gmu)].map(match => match[1]))].sort();
}

function testCounts(log) {
  const sum = key => [...log.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, 'gmu'))].reduce((n, match) => n + Number(match[1]), 0);
  return { tests: sum('tests'), passed: sum('pass'), failed: sum('fail'), skipped: sum('skipped'), failures: failures(log) };
}

async function checkTests(baseline) {
  const before = run(['suite.mjs', 'baseline'], baseline);
  await writeFile(`${output}/baseline.log`, before.text);
  const after = run(['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    ...files.map(file => `--include=${file}`), `--temp-directory=${output}/raw-coverage`,
    `--report-dir=${output}/coverage`, '--reporter=json', '--reporter=json-summary', '--reporter=text-summary',
    'node', 'tools/transfer-yard-posting-suite.mjs', 'final']);
  await writeFile(`${output}/tests.log`, after.text);
  const old = testCounts(before.text), current = testCounts(after.text);
  const added = current.failures.filter(name => !old.failures.includes(name));
  await writeFile(`${output}/tests.json`, JSON.stringify({ baseline: old, current, newFailures: added }, null, 2) + '\n');
  console.log(JSON.stringify({ baseline: old, current, newFailures: added }));
  assert.ok(current.tests > old.tests && current.tests > 250, 'The full selected suite must finish');
  assert.deepEqual(added, [], 'No new regression failures');
  assert.equal(current.failed, current.failures.length, 'No cancelled or hidden failures');
  const reverse = run(['tools/transfer-yard-posting-suite.mjs', 'reverse']);
  await writeFile(`${output}/reverse.log`, reverse.text);
  assert.deepEqual(testCounts(reverse.text), current, 'Reversing suite order must preserve results');
}

async function checkStatic(baseline) {
  const lintConfig = `import base from './eslint.mbt.config.js';\nexport default [...base, {...base[0], files: ['src/transfer-order-posting-*.js', 'src/movement-record-evidence.js', 'src/consolidation-load-posting.js']}];\n`;
  const lintResults = {};
  for (const [label, cwd] of [['baseline', baseline], ['current', root]]) {
    // Config must resolve the existing rules from the same source tree.
    const configPath = label === 'baseline' ? `${baseline}/scope-eslint.mjs` : `${output}/scope-eslint.mjs`;
    await writeFile(configPath, label === 'baseline' ? lintConfig : lintConfig.replace("'./eslint.mbt.config.js'", "'/app/eslint.mbt.config.js'"));
    const result = run(['node_modules/eslint/bin/eslint.js', '--config', configPath, '--format=json', ...files], cwd);
    await writeFile(`${output}/lint-${label}.json`, result.text);
    lintResults[label] = JSON.parse(result.text).flatMap(file => file.messages.map(message => ({
      file: file.filePath.replace(`${cwd}/`, ''), rule: message.ruleId, message: message.message
    })));
  }
  const newLint = lintResults.current.filter(item => !lintResults.baseline.some(old => JSON.stringify(item) === JSON.stringify(old)));
  await writeFile(`${output}/lint-comparison.json`, JSON.stringify({ ...lintResults, newIssues: newLint }, null, 2) + '\n');
  console.log(`New lint issues: ${newLint.length}`);
  for (const file of files) { assert.equal(run(['--check', file]).exitCode, 0, file); }
  const typeResults = {};
  const typeBase = JSON.parse(await readFile(`${root}/tsconfig.mbt.json`, 'utf8'));
  const scopedTypes = { compilerOptions: typeBase.compilerOptions, files };
  await writeFile(`${output}/types-scope.json`, JSON.stringify(scopedTypes, null, 2) + '\n');
  for (const [label, cwd] of [['baseline', baseline], ['current', root]]) {
    const configPath = label === 'baseline' ? `${baseline}/scope-types.json` : `${output}/scope-types.json`;
    const configuration = { ...scopedTypes, files: files.map(file => `${cwd}/${file}`), compilerOptions: { ...scopedTypes.compilerOptions, typeRoots: [`${cwd}/node_modules/@types`] } };
    await writeFile(configPath, JSON.stringify(configuration));
    const result = run(['node_modules/typescript/bin/tsc', '--project', configPath, '--noEmit', '--pretty', 'false'], cwd);
    await writeFile(`${output}/types-${label}.log`, result.text);
    typeResults[label] = [...new Set(result.text.split('\n').filter(line => /error TS\d+/u.test(line))
      .map(line => line.replace(/\(\d+,\d+\)/u, '').replaceAll(`${cwd}/`, '')))];
  }
  const newTypes = typeResults.current.filter(line => !typeResults.baseline.includes(line));
  await writeFile(`${output}/type-comparison.json`, JSON.stringify({ baselineCount: typeResults.baseline.length,
    currentCount: typeResults.current.length, newIssues: newTypes }, null, 2) + '\n');
  console.log(`New type errors: ${newTypes.length}`);
  assert.deepEqual(newLint, [], 'New lint issues');
  assert.deepEqual(newTypes, [], 'New type errors');
}

async function identifySource() {
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(`${root}/${file}`)).digest('hex')])));
  const versions = { node: process.version };
  for (const name of ['typescript', 'eslint', 'c8', 'fast-check']) {
    versions[name] = JSON.parse(await readFile(`${root}/node_modules/${name}/package.json`, 'utf8')).version;
  }
  const suiteFiles = JSON.parse(await readFile(`${root}/tools/transfer-yard-posting-suites.json`, 'utf8'));
  suiteFiles.push('test/mbt/integration/transfer-yard-posting.test.js', 'test/support/operator-to-yard-flow-fixture.mjs');
  const tests = Object.fromEntries(await Promise.all(suiteFiles.map(async file => [file, createHash('sha256').update(await readFile(`${root}/${file}`)).digest('hex')])));
  const findings = [];
  for (const file of files) {
    const oldLines = new Set((await readFile(`${artifact}/before/${file}`, 'utf8')).split('\n'));
    const added = (await readFile(`${root}/${file}`, 'utf8')).split('\n').filter(line => !oldLines.has(line));
    findings.push(...scanTextForSecrets(added.join('\n'), file));
  }
  await writeFile(`${output}/secrets.json`, JSON.stringify({ scope: 'Added runtime source lines', findings }, null, 2) + '\n');
  assert.deepEqual(findings, [], 'No secrets in the scoped runtime change');
  await writeFile(`${output}/source.json`, JSON.stringify({ hashes, tests, versions }, null, 2) + '\n');
}

const mode = process.argv[2] || 'all';
let baseline;
try {
  baseline = await stageBaseline();
  if (mode === 'all' || mode === 'static') { await checkStatic(baseline); }
  if (mode === 'all' || mode === 'tests') { await checkTests(baseline); }
  if (mode === 'all' || mode === 'mutations') {
    const result = run(['tools/transfer-yard-posting-mutations.mjs']);
    await writeFile(`${output}/mutations.log`, result.text);
    assert.equal(result.exitCode, 0, result.text);
  }
  await identifySource();
} finally {
  if (baseline) { await rm(baseline, { recursive: true, force: true }); }
}
