import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const phase = process.argv[2] || 'focused';
const cases = [
  'test/dispatch/frontend/dispatch-source-refresh.test.js',
  'test/dispatch/frontend/dispatch-save-reliability.test.js',
  'test/dispatch/frontend/dispatch-source-decision.test.js',
  'test/dispatch/property/dispatch-source-refresh.property.test.js',
  'test/dispatch/property/dispatch-save-reliability.test.js',
  'test/dispatch/integration/dispatch-source-decision.test.js',
  'test/dispatch/integration/dispatch-save-reliability.test.js'
];
const browserCases = ['test/dispatch/frontend/dispatch-notice-stability.browser.test.mjs'];
mkdirSync('test-artifacts/source-save', { recursive: true });
function run(name, executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(`test-artifacts/source-save/${name}.log`, output);
  console.log(JSON.stringify({ name, status: result.status, summary: output.split('\n').filter(line => /^# (tests|pass|fail|duration_ms|skipped)/u.test(line)) }));
  if (result.status === 0 && ['quality', 'mutations', 'coverage-summary'].includes(name)) {console.log(output.trim());}
  if (result.status !== 0) {
    const failures = output.match(/not ok [\s\S]*?(?=\n(?:ok |not ok |# Subtest:|1\.\.)|$)/gu);
    console.log(failures ? failures.join('\n') : output.slice(-12000));
    process.exitCode = 1;
  }
}
if (phase === 'focused') {run('focused', 'node', ['--test', '--test-concurrency=1', ...cases]);}
if (phase === 'all') {
  run('focused', 'node_modules/.bin/c8', ['--all=false', '--include=src/dispatch-source-refresh.js', '--include=src/dispatch-executed-order-review-repository.js',
    '--reporter=text', '--reporter=json', '--reports-dir=test-artifacts/source-save/coverage', '--temp-directory=test-artifacts/source-save/v8',
    'node', '--test', '--test-concurrency=1', ...cases]);
}
if (['browser', 'all'].includes(phase)) {run('browser', 'node', ['--test', ...browserCases]);}
if (['quality', 'all'].includes(phase)) {
  run('quality', 'node', ['tools/dispatch-source-save-quality.mjs']);
  run('mutations', 'node', ['tools/dispatch-source-save-mutations.mjs']);
}
if (phase === 'all') {
  run('reverse-order', 'node', ['--test', '--test-concurrency=1', cases[3], cases[0]]);
  run('coverage-summary', 'node', ['tools/dispatch-source-save-coverage.mjs']);
}
