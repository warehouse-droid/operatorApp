import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync, rmSync, readdirSync, existsSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import crypto from 'node:crypto';
import {ESLint} from 'eslint';
import coverageLib from 'istanbul-lib-coverage';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';

const sources = ['src/sor-rental-repository.js', 'src/sor-rental-service.js', 'src/dispatch-custom-order-repository.js',
  'src/sor-return-source.js', 'src/sor-return-projection-repository.js'];
const focused = 'test/dispatch/integration/sor-return-source-refresh.test.js';
const artifact = resolve('test-artifacts/sor-return-source-refresh');
mkdirSync(artifact, {recursive: true});
const mode = process.argv[2] || 'all';
const suite = readdirSync('test/dispatch/integration').filter(file => /^sor-.*\.test\.js$/u.test(file))
  .map(file => `test/dispatch/integration/${file}`).concat([
    'test/dispatch/unit/sor-rental-policy.test.js',
    'test/dispatch/unit/dispatch-sor-return-date-conflict.test.js',
    'test/dispatch/integration/dispatch-sor-return-date-conflict.test.js',
    'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js'
  ]).sort((left, right) => crypto.createHash('sha256').update(`248:${left}`).digest('hex')
    .localeCompare(crypto.createHash('sha256').update(`248:${right}`).digest('hex')));
if (['suite', 'focused', 'custom-baseline', 'custom-candidate'].includes(mode)) {
  const selected = mode === 'focused' ? [focused] : mode === 'custom-baseline'
    ? [`${artifact}/baseline/src/dispatch-custom-order-harness.js`] : mode === 'custom-candidate'
      ? ['src/dispatch-custom-order-harness.js'] : suite;
  process.exitCode = await runNodeTestFilesIsolated(selected, {environment: process.env, label: 'sor-source-refresh'});
} else {
  const report = {suiteOrderSeed: 248, sourceHashes: Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(readFileSync(file)).digest('hex')])),
    toolchain: {node: process.version, ...Object.fromEntries(['typescript','eslint','c8','fast-check','pg'].map(name =>
      [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version]))}, steps: []};
  function run(name, args, {expectedFailure = false, ...options} = {}) {
    const result = spawnSync(process.execPath, args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options});
    const output = (result.stdout || '') + (result.stderr || '');
    writeFileSync(`${artifact}/${name}.log`, output);
    const entry = {name, status: result.status, signal: result.signal,
      summaries: output.split('\n').filter(line => /^(# (tests|pass|fail|skipped)|Isolated )/u.test(line))};
    report.steps.push(entry);
    console.log(JSON.stringify(entry));
    if (result.status !== 0 && !expectedFailure) {console.log(output.slice(-12000));}
    return result;
  }
  const checker = new ESLint({overrideConfigFile: true, overrideConfig: [{files: ['**/*.{js,mjs}'],
    languageOptions: {ecmaVersion: 'latest', sourceType: 'module', globals: {console: 'readonly', process: 'readonly',
      Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', structuredClone: 'readonly'}},
    rules: {'eqeqeq': 'error', 'no-undef': 'error', 'no-unreachable': 'error', 'no-constant-condition': 'error',
      'no-unused-vars': ['error', {argsIgnorePattern: '^_'}], 'no-var': 'error', 'prefer-const': 'error'}}]});
  const sourceChanges = JSON.parse(readFileSync('test-artifacts/source-changes.json', 'utf8')).changedLines;
  const allLint = (await checker.lintFiles([...sources, focused])).flatMap(file => file.messages.map(message =>
    ({file: file.filePath, line: message.line, message: message.message})));
  const baselineLint = allLint.filter(message => sourceChanges[relative(process.cwd(), message.file)] &&
    !sourceChanges[relative(process.cwd(), message.file)].includes(message.line));
  const lint = allLint.filter(message => !baselineLint.includes(message));
  const typeRun = spawnSync(process.execPath, ['node_modules/typescript/lib/tsc.js', '--allowJs', '--checkJs', '--noEmit',
    '--skipLibCheck', '--strict', 'false', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--pretty', 'false', ...sources],
  {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (typeRun.error || typeRun.signal) {throw new Error(`Type checker failed: ${typeRun.error || typeRun.signal}`);}
  // Existing application modules are untyped. Check the two new module
  // boundaries; syntax and lint cover all five changed runtime modules.
  writeFileSync(`${artifact}/types.log`, typeRun.stdout + typeRun.stderr);
  const types = (typeRun.stdout + typeRun.stderr).split('\n').filter(line =>
    sources.slice(3).some(file => line.startsWith(`${file}(`)) || /Cannot find module|Unknown compiler option/u.test(line));
  const syntax = sources.map(file => ({file, status: spawnSync(process.execPath, ['--check', file]).status}));
  report.static = {lint, baselineLint, types, typeScope: 'Two new JS modules; checkJs=true, strict=false; existing modules syntax/lint', syntax};
  report.static.secrets = sources.flatMap(file => scanUnifiedDiff(`+++ b/${file}\n@@ -0,0 +1,1 @@\n` +
    readFileSync(file, 'utf8').split('\n').map(line => `+${line}`).join('\n')));
  console.log(JSON.stringify({static: report.static}));
  let failed = Boolean(lint.length || types.length || syntax.some(value => value.status) || report.static.secrets.length);
  if (!failed && mode !== 'static') {
    const baseline = `${artifact}/baseline`;
    mkdirSync(baseline, {recursive: true});
    try {
      cpSync('src', `${baseline}/src`, {recursive: true});
      for (const file of sources) {
        const before = `test-artifacts/source-before/${file}`;
        if (existsSync(before)) {cpSync(before, `${baseline}/${file}`);}
      }
      for (const directory of ['public', 'migrations', 'node_modules']) {symlinkSync(resolve(directory), `${baseline}/${directory}`);}
      cpSync('package.json', `${baseline}/package.json`);
      const before = run('custom-baseline', ['tools/sor-return-source-refresh-checks.mjs', 'custom-baseline'], {expectedFailure: true});
      const after = run('custom-candidate', ['tools/sor-return-source-refresh-checks.mjs', 'custom-candidate'], {expectedFailure: true});
      const reason = result => ((result.stdout || '') + (result.stderr || '')).match(/AssertionError \[ERR_ASSERTION\]: ([^\n]+)/u)?.[1] || '';
      report.customHarness = {baselineStatus: before.status, candidateStatus: after.status,
        baselineFailure: reason(before), candidateFailure: reason(after)};
      failed ||= after.status !== 0 && !(before.status !== 0 && reason(before) && reason(before) === reason(after));
      console.log(JSON.stringify({customHarness: report.customHarness}));
    } finally {rmSync(baseline, {recursive: true, force: true});}
    const result = run('coverage-suite', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
      ...sources.map(file => `--include=${file}`), `--temp-directory=${artifact}/c8`, `--report-dir=${artifact}/coverage`,
      '--reporter=json', '--reporter=json-summary', 'node', 'tools/sor-return-source-refresh-checks.mjs', 'suite']);
    failed ||= result.status !== 0;
    if (!failed) {
      report.coverage = JSON.parse(readFileSync(`${artifact}/coverage/coverage-summary.json`, 'utf8'));
      const map = coverageLib.createCoverageMap(JSON.parse(readFileSync(`${artifact}/coverage/coverage-final.json`, 'utf8')));
      const changes = JSON.parse(readFileSync('test-artifacts/source-changes.json', 'utf8')).changedLines;
      report.changedLineCoverage = {covered: 0, total: 0, uncovered: []};
      for (const [file, lines] of Object.entries(changes)) {
        const lineCoverage = map.fileCoverageFor(resolve(file)).getLineCoverage();
        for (const line of lines) {
          if (!(line in lineCoverage)) {continue;}
          report.changedLineCoverage.total++;
          if (lineCoverage[line] > 0) {report.changedLineCoverage.covered++;}
          else {report.changedLineCoverage.uncovered.push(`${file}:${line}`);}
        }
      }
      failed ||= report.changedLineCoverage.uncovered.length > 0;
      const mutations = [
        ['assigned-stays-blocked', sources[0], 'activity.started || (!draft && activity.assigned)', 'activity.assigned || activity.started || (!draft && activity.assigned)'],
        ['skip-plan-refresh', sources[4], "if (customOrder.status === 'open') {await refreshAssignedPlans(customOrder);}", '/* mutant: stale plan */'],
        ['skip-derived-catalog', sources[4], 'if (definition) {', 'if (false) {'],
        ['rewrite-completed', sources[0], "previous?.status==='completed' || ", ''],
        ['unordered-fingerprint', sources[3], 'JSON.stringify(sorted(normalized))', 'JSON.stringify(normalized)']
      ];
      report.mutations = [];
      for (const [name, file, from, to] of mutations) {
        const root = `${artifact}/mutant-${name}`;
        mkdirSync(root, {recursive: true});
        try {
          for (const directory of ['src','test','public','migrations']) {cpSync(directory, `${root}/${directory}`, {recursive: true});}
          cpSync('package.json', `${root}/package.json`);
          symlinkSync(resolve('node_modules'), `${root}/node_modules`);
          const code = readFileSync(`${root}/${file}`, 'utf8');
          if (!code.includes(from)) {throw new Error(`Missing mutation target: ${name}`);}
          writeFileSync(`${root}/${file}`, code.replace(from, to));
          const outcome = run(name, ['--test', '--test-concurrency=1', focused], {cwd: root, expectedFailure: true});
          const killed = outcome.status !== 0 && /ERR_ASSERTION|ERR_TEST_FAILURE/u.test(outcome.stdout);
          const property = run(`${name}-property`, ['--test', '--test-name-pattern=JSON key ordering', focused], {cwd: root, expectedFailure: true});
          report.mutations.push({name, killed, propertyKilled: property.status !== 0 && /ERR_ASSERTION|ERR_TEST_FAILURE/u.test(property.stdout)});
          failed ||= !killed;
        } finally {rmSync(root, {recursive: true, force: true});}
      }
      const reverse = run('focused-repeat', ['--test', '--test-concurrency=1', focused]);
      failed ||= reverse.status !== 0;
    }
  }
  report.passed = !failed;
  writeFileSync(`${artifact}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = failed ? 1 : 0;
}
