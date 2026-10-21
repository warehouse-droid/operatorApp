import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sources, tests } from './manifest.mjs';
const out = 'test-artifacts/sales-order-null-packs-20261016';
const mode = process.argv[2] || 'tests';
mkdirSync(out, { recursive: true });
function run(name, args, expectedFailures = []) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(`${out}/${name}.log`, result.stdout + result.stderr);
  console.log(`${name}: exit ${result.status}`);
  const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  if (result.status !== 0 && JSON.stringify(failures) === JSON.stringify(expectedFailures.toSorted()) && failures.length) {
    console.log(`${name}: only ${failures.length} independently reproduced baseline failure`);
  } else if (result.status !== 0) { console.log((result.stdout + result.stderr).slice(-5000)); process.exit(result.status || 1); }
}
if (mode === 'tests') {
  run('regression', ['--test', '--test-concurrency=1', ...tests]);
} else if (mode === 'static') {
  for (const file of sources) run('syntax-' + file.replaceAll('/', '-'), ['--check', file]);
  run('types', ['tools/sales-order-null-packs-20261016/types.mjs']);
  run('lint', ['node_modules/eslint/bin/eslint.js', '--config', 'tools/sales-order-null-packs-20261016/eslint.config.mjs', '--max-warnings=0', ...sources]);
} else if (mode === 'final') {
  run('static', ['tools/sales-order-null-packs-20261016/check.mjs', 'static']);
  run('baseline-integration', ['tools/sales-order-null-packs-20261016/baseline-red.mjs', 'integration']);
  const expectedFailures = JSON.parse(readFileSync(`${out}/baseline-failures.json`, 'utf8'));
  rmSync(`${out}/coverage`, { recursive: true, force: true });
  run('coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--temp-directory=/tmp/so-packs-coverage', `--report-dir=${out}/coverage`, '--reporter=text', '--reporter=json', '--reporter=json-summary',
    ...sources.map(file => '--include=' + file), 'node', '--test', '--test-concurrency=1', ...tests], expectedFailures);
  let seed = 20261016;
  const shuffled = [...tests];
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  writeFileSync(`${out}/shuffled-order.json`, JSON.stringify({ seed: 20261016, files: shuffled }, null, 2));
  for (const [i, file] of shuffled.entries()) run(`shuffled-${i}`, ['--test', file], file.endsWith('/integration/special-request-enhancements.test.js') ? expectedFailures : []);
  run('mutations', ['tools/sales-order-null-packs-20261016/mutations.mjs']);
  writeFileSync(`${out}/source-hashes.json`, JSON.stringify(Object.fromEntries([...sources, ...tests].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])), null, 2));
  writeFileSync(`${out}/versions.json`, JSON.stringify({ node: process.version, ...Object.fromEntries(['fast-check', 'typescript', 'eslint', 'c8', 'playwright'].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version])) }, null, 2));
}
