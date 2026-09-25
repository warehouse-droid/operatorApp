// Repeat a suspected pre-existing race without editing or weakening its test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { withCoTestDatabase } from '../test/support/co-direct-to-isolation.mjs';

const mode = process.argv[2] || 'candidate';
const fullFile = process.argv.includes('--full-file');
const report = { mode, startedAt: new Date().toISOString(), attempts: [] };
for (let attempt = 1; attempt <= (fullFile ? 20 : 10); attempt++) {
  const args = [...(process.argv.includes('--cancel-first') ? ['--experimental-loader', './test/support/dispatch-save-co-race-order.mjs'] : []), '--test', ...(!fullFile ? ['--test-name-pattern=concurrent plan ownership and cancellation'] : []),
    'test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js'];
  if (fullFile) args.unshift('node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
    '--reporter=json', `--report-dir=test-artifacts/dispatch-save-reliability/flake-coverage-${mode}`,
    `--temp-directory=test-artifacts/dispatch-save-reliability/flake-v8-${mode}`, 'node');
  const result = await withCoTestDatabase(`save-flake-${mode}-${attempt}`, databaseUrl => spawnSync(process.execPath,
    args,
    { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  assert.equal(result.error, undefined);
  const output = result.stdout + result.stderr;
  await writeFile(`test-artifacts/dispatch-save-reliability/flake-${mode}-${attempt}.log`, output);
  report.attempts.push({ attempt, exitCode: result.status, sameFailure: /2 !== 1/.test(output) });
  console.log(JSON.stringify(report.attempts.at(-1)));
}
report.completedAt = new Date().toISOString();
await writeFile(`test-artifacts/dispatch-save-reliability/flake-${mode}.json`, JSON.stringify(report, null, 2));
