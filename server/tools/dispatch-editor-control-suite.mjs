import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const mode = process.argv[2] || 'all';
const suites = ['test/dispatch/frontend/dispatch-editor-idle.test.js', 'test/dispatch/frontend/dispatch-editor-actions.test.js',
  'test/dispatch/integration/dispatch-editor-control.test.js'];
if (mode !== 'red') suites.push('test/dispatch/frontend/dispatch-save-reliability.test.js',
  'test/dispatch/integration/dispatch-save-reliability.test.js', 'test/dispatch/property/dispatch-edit-lease-session.property.test.js',
  'test/dispatch/integration/dispatch-editor-confirmation.browser.test.js');
if (mode === 'browser') {suites.splice(0, suites.length, 'test/dispatch/integration/dispatch-editor-confirmation.browser.test.js');}
if (mode === 'actions') {suites.splice(0, suites.length, 'test/dispatch/frontend/dispatch-editor-actions.test.js');}
const command = mode === 'static' ? ['tools/dispatch-editor-control-static.mjs']
  : mode === 'mutation' ? ['tools/dispatch-editor-control-mutations.mjs']
  : ['tools/bin-planning-suites.mjs', 'selected', ...suites];
const coverage = ['all', 'candidate'].includes(mode) ? ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  '--include=src/dispatch-plan-lease-repository.js', '--include=public/dispatch-edit-activity.js', '--reporter=text', '--reporter=json',
  '--reporter=json-summary', '--report-dir=test-artifacts/coverage', '--temp-directory=/tmp/editor-control-c8', process.execPath] : [];
const result = spawnSync(process.execPath, [...coverage, ...command],
  { encoding: 'utf8', env: process.env, timeout: 600000 });
writeFileSync('test-artifacts/suites.log', result.stdout + result.stderr);
console.log(result.stdout + result.stderr);
writeFileSync('test-artifacts/result.json', JSON.stringify({ mode, exit: result.status, node: process.version }, null, 2));
let code = result.status ?? 1;
if (!code && ['all', 'candidate'].includes(mode)) {
  const checked = spawnSync(process.execPath, ['tools/dispatch-editor-control-static.mjs'], { encoding: 'utf8' });
  writeFileSync('test-artifacts/static.log', checked.stdout + checked.stderr);
  console.log(checked.stdout + checked.stderr);
  code = checked.status ?? 1;
  if (!code) {
    const mutation = spawnSync(process.execPath, ['tools/dispatch-editor-control-mutations.mjs'], { encoding: 'utf8', timeout: 600000 });
    writeFileSync('test-artifacts/mutations.log', mutation.stdout + mutation.stderr);
    console.log(mutation.stdout + mutation.stderr);
    code = mutation.status ?? 1;
  }
  if (!code) {
    const repeated = spawnSync(process.execPath, ['tools/bin-planning-suites.mjs', 'selected', ...suites.slice(0, 3).reverse()],
      { encoding: 'utf8', env: process.env, timeout: 120000 });
    writeFileSync('test-artifacts/reversed-order.log', repeated.stdout + repeated.stderr);
    console.log(repeated.stdout + repeated.stderr);
    code = repeated.status ?? 1;
  }
}
process.exitCode = code;
