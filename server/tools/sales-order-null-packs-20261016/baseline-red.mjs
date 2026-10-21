import { cpSync, mkdtempSync, symlinkSync, readdirSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync('/tmp/so-null-red-');
try {
  for (const dir of ['src', 'public', 'test']) cpSync(dir, join(root, dir), { recursive: true });
  for (const name of ['package.json', 'netsuite-field-sales-restlet.js', 'netsuite-smart-scm-picking-ticket-restlet.js']) copyFileSync(name, join(root, name));
  symlinkSync('/app/node_modules', join(root, 'node_modules'));
  symlinkSync('/app/migrations', join(root, 'migrations'));
  const before = 'test-artifacts/sales-order-null-packs-20261016/before';
  for (const name of readdirSync(before, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true }); copyFileSync(join(before, name), join(root, name));
  }
  // Direct transport dependency injection was added with the fix, so exercise
  // the pre-existing public creation/domain contracts in the baseline run.
  const integration = process.argv[2] === 'integration';
  const result = spawnSync(process.execPath, integration ? ['--test', 'test/mbt/integration/special-request-enhancements.test.js'] : ['--test', '--test-name-pattern', 'empty or zero|pack edits|property:|invalid pack|discounted direct|Field Sales', 'test/mbt/unit/sales-order-null-packs.test.js'], { cwd: root, encoding: 'utf8' });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  if (result.status === 0 || !result.stdout.includes('ERR_ASSERTION')) throw Error('Baseline did not reproduce the pack behavior failure.');
  if (integration) {
    const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
    if (failures.length !== 1 || failures[0] !== 'Sales alert counts are own requests within permitted yards, regardless of list pagination') throw Error('Unexpected baseline regression failures.');
    writeFileSync('test-artifacts/sales-order-null-packs-20261016/baseline-failures.json', JSON.stringify(failures, null, 2));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
