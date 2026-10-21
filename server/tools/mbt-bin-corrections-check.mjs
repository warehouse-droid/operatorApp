import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
const mode = process.argv[2] || 'all';
const files = mode === 'baseline' ? [] : [
  'test/mbt/unit/mbt-bin-corrections.test.js',
  'test/mbt/integration/mbt-bin-corrections.test.js'
];
if (['cancel-red', 'cancel'].includes(mode)) { files.length = 0; }
if (['all', 'cancel-red', 'cancel'].includes(mode)) {
  files.push('test/mbt/unit/mbt-bin-cancellation.test.js', 'test/mbt/integration/mbt-bin-cancellation.test.js');
}
if (['all', 'browser', 'candidate'].includes(mode)) {
  files.push('test/mbt/integration/mbt-bin-corrections-browser.test.js');
}
if (['all', 'baseline'].includes(mode)) {
  for (const directory of ['unit', 'integration', 'concurrency', 'property', 'contracts']) {
    for (const file of readdirSync(`test/mbt/${directory}`)) {
      if (/^(bin-planning-|frontdesk-multibin-|bin-contract-front-leg|customer-charge-)/u.test(file) && file.endsWith('.test.js')) {
        files.push(`test/mbt/${directory}/${file}`);
      }
    }
  }
}
const args = ['tools/bin-planning-suites.mjs', 'selected', ...files];
function run(name, commandArgs, environment = process.env) {
  const result = spawnSync(process.execPath, commandArgs, { encoding: 'utf8', env: environment, timeout: 900000 });
  writeFileSync(`test-artifacts/${name}.log`, result.stdout + result.stderr);
  console.log(result.stdout + (result.status ? result.stderr : ''));
  return result.status ?? 1;
}
let code = 0;
if (mode === 'static') {
  code = run('static-run', ['tools/mbt-bin-corrections-static.mjs']);
} else if (mode === 'mutation') {
  code = run('mutation-run', ['tools/mbt-bin-corrections-mutations.mjs']);
} else {
  const coverage = mode === 'all' ? ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    '--include=src/mbt/**', '--reporter=json', '--reporter=text', '--reporter=json-summary',
    '--temp-directory=/tmp/bin-corrections-c8', '--report-dir=test-artifacts/coverage', process.execPath] : [];
  code = run('suite', [...coverage, ...args]);
  if (!code && mode === 'all') {
    code ||= run('static-run', ['tools/mbt-bin-corrections-static.mjs']);
    code ||= run('repeat', ['tools/bin-planning-suites.mjs', 'selected', ...files.slice(0, 5).reverse()]);
    code ||= run('mutation-run', ['tools/mbt-bin-corrections-mutations.mjs']);
    code ||= run('coverage-review', ['tools/mbt-bin-corrections-coverage.mjs']);
  }
}
writeFileSync('test-artifacts/result.json', JSON.stringify({ mode, files, exit: code, node: process.version }, null, 2));
process.exitCode = code;
console.log(JSON.stringify({ mode, exit: code }));
