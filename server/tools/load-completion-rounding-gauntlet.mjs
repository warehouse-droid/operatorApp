import { readdirSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from '../test/support/test-database-isolation.mjs';

const artifact = '/app/test-artifacts/load-completion-rounding';
mkdirSync(artifact, { recursive: true });
const matches = /^(?:operator-netsuite-posting-|operator-posting-|operator-ui-enhancements\.|pickup-remaining-packs\.|load-completion-rounding\.|group-underpack(?:-ui)?\.|customer-pickup-yard-scope\.|child-location-parts-service\.|consolidation-load(?:-posting)?\.)/;
const files = ['unit', 'integration', 'property', 'concurrency', 'adversarial'].flatMap(folder =>
  readdirSync(`test/mbt/${folder}`).filter(file => file.endsWith('.js') && matches.test(file))
    .map(file => `test/mbt/${folder}/${file}`));
const sourceFiles = ['src/operator-load-quantity.js', 'src/delivery-repository.js', 'public/operator.js'];
const digest = createHash('sha256');
for (const path of sourceFiles) { digest.update(path); digest.update(readFileSync(path)); }
const sourceHash = digest.digest('hex');
console.log(`Source SHA256 ${sourceHash}; ${files.length} affected test files`);
files.sort((left, right) => createHash('sha256').update(`10636:${left}`).digest('hex').localeCompare(
  createHash('sha256').update(`10636:${right}`).digest('hex')));
const baselineCandidates = new Set(['test/mbt/integration/consolidation-load.test.js', 'test/mbt/integration/operator-posting-photos.test.js']);

function run(label, command, args, env = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(`${artifact}/${label}.log`, `${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    console.log(`${label} FAILED (${result.status})\n${output.slice(Math.max(0, output.lastIndexOf('✖ failing tests:'), output.length - 18000))}`);
    process.exit(result.status || 1);
  }
  console.log(`${label} PASS\n${(result.stdout || '').split('\n').slice(-12).join('\n')}`);
}

const boundary = describeIsolatedTestDatabase(process.env.DATABASE_URL, process.env);
const admin = new pg.Client({ connectionString: boundary.adminUrl });
const results = [];
async function compareBaseline(index, file, result, failures) {
  const database = isolatedTestDatabaseName(`load-rounding-baseline-${process.pid}`, index);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE mbt_test`);
  try {
    const baseline = spawnSync('node', ['--import', './test/support/load-completion-rounding-baseline-loader.mjs',
      '--test', '--test-reporter=tap', file], { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: isolatedTestDatabaseUrl(process.env.DATABASE_URL, database) } });
    const output = `${baseline.stdout || ''}${baseline.stderr || ''}`;
    writeFileSync(`${artifact}/baseline-${index}.log`, output);
    const baselineFailures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
    return { baselineFailures, baselineMatched: baseline.status === result.status && failures.length > 0
      && JSON.stringify(failures) === JSON.stringify(baselineFailures) };
  } finally { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
}
await admin.connect();
try {
  for (const [index, file] of (process.argv.includes('--checks-only') ? [] : files).entries()) {
    const database = isolatedTestDatabaseName(`load-rounding-${process.pid}`, index);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE mbt_test`);
    try {
      const result = spawnSync('node', ['--test', '--test-reporter=tap', '--test-concurrency=1', file],
        { encoding: 'utf8', env: { ...process.env, DATABASE_URL: isolatedTestDatabaseUrl(process.env.DATABASE_URL, database) },
          timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      writeFileSync(`${artifact}/test-${index}.log`, output);
      const counts = Object.fromEntries(['tests', 'pass', 'fail'].map(key => [key, Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
      const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
      results.push({ file, status: result.status, ...counts, failures });
      if (result.status !== 0 && baselineCandidates.has(file)) {
        Object.assign(results.at(-1), await compareBaseline(index, file, result, failures));
      }
      console.log(JSON.stringify(results.at(-1)));
      if (result.status !== 0 && !results.at(-1).baselineMatched) {
        const blocks = output.split(/(?=# Subtest:)/).filter(block => /^not ok /m.test(block));
        console.log((blocks.join('\n') || output).slice(-18000));
      }
    } finally { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
  }
} finally { await admin.end(); }
const summary = { files: results.length, tests: results.reduce((sum, result) => sum + result.tests, 0),
  passed: results.reduce((sum, result) => sum + result.pass, 0), failedFiles: results.filter(result => result.status !== 0).length,
  newFailures: results.filter(result => result.status !== 0 && !result.baselineMatched).length };
writeFileSync(`${artifact}/tests.json`, JSON.stringify({ summary, results }));
console.log(JSON.stringify(summary));
if (summary.newFailures) { process.exit(1); }
if (process.argv.includes('--tests-only')) { process.exit(0); }
run('syntax-backend', 'node', ['--check', 'src/delivery-repository.js']);
run('syntax-frontend', 'node', ['--check', 'public/operator.js']);
run('types', 'node_modules/.bin/tsc', ['--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--target', 'ES2022',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'src/operator-load-quantity.js']);
run('lint', 'node_modules/.bin/eslint', ['--config', 'tools/load-completion-rounding-eslint.mjs', '--max-warnings=0',
  'src/operator-load-quantity.js', 'test/mbt/unit/load-completion-rounding.test.js', 'test/mbt/integration/load-completion-rounding.test.js',
  'tools/load-completion-rounding-gauntlet.mjs']);
run('coverage', 'node_modules/.bin/c8', ['--all=false', '--include=src/operator-load-quantity.js',
  `--temp-directory=${artifact}/c8`, `--reports-dir=${artifact}/coverage`, '--reporter=text', '--reporter=json-summary',
  '--check-coverage', '--lines=100', '--functions=100', '--statements=100', '--branches=100',
  'node', '--test', '--test-reporter=spec', 'test/mbt/unit/load-completion-rounding.test.js']);
run('mutations', 'node', ['test/support/load-completion-rounding-mutations.mjs']);
writeFileSync(`${artifact}/evidence.json`, JSON.stringify({ sourceHash, summary,
  knownBaselineFailures: results.filter(result => result.baselineMatched).map(result => ({ file: result.file, failures: result.failures })),
  syntax: 'passed', types: 'passed', lint: 'passed', mutation: { killed: 6, total: 6, propertyOnly: true },
  coverage: JSON.parse(readFileSync(`${artifact}/coverage/coverage-summary.json`, 'utf8')),
  baselineRepositoryHash: createHash('sha256').update(readFileSync('/app/test-artifacts/baseline-delivery-repository.js')).digest('hex')
}, null, 2));
