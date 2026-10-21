import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = `/tmp/scm-schedule-search-mutations-${process.pid}`;
const out = '/app/test-artifacts/scm-schedule-search-20261014';
const files = ['src/scm-order-visibility.js', 'src/server.js', 'src/dispatch-repository.js', 'public/scm-schedule.js'];
const tests = ['test/dispatch/frontend/scm-schedule-search.test.js',
  'test/mbt/integration/scm-schedule-search.test.js', 'test/mbt/unit/scm-schedule-search-policy.test.js'];
const mutants = [
  ['client-reapplies-filters', 'public/scm-schedule.js',
    'return Boolean(String(scmScheduleFilters.search || "").trim())',
    'return false && Boolean(String(scmScheduleFilters.search || "").trim())'],
  ['sales-search-loses-restricted-rows', 'src/server.js',
    'const rows = await listScmSchedule(searchAcrossOrders ? {\n      search: req.query.search,\n      audience: "schedule_search"',
    'const rows = await listScmSchedule(searchAcrossOrders ? {\n      search: req.query.search,\n      audience: "operations"'],
  ['hold-final-filter-reversed', 'src/scm-order-visibility.js',
    '.trim().toLowerCase() !== "hold");', '.trim().toLowerCase() === "hold");'],
  ['blank-search-enables-policy', 'src/scm-order-visibility.js',
    'if (!String(search || "").trim()) return false;', 'if (!String(search || "").trim()) return true;'],
  ['sales-search-leaks-other-yards', 'src/server.js',
    'const scoped = rows.filter((row) => salesScheduleRowMatchesYards(row, yardCodes));', 'const scoped = rows;'],
  ['blanket-query-gate-restored', 'src/dispatch-repository.js',
    "$26::boolean\n        OR $9 = 'blanket'", "false\n        OR $9 = 'blanket'"],
  ['cancelled-split-query-gate-restored', 'src/dispatch-repository.js',
    'AND ($26::boolean OR NOT EXISTS (\n          SELECT 1\n            FROM dispatch_scm_po_splits cancelled_split',
    'AND (false OR NOT EXISTS (\n          SELECT 1\n            FROM dispatch_scm_po_splits cancelled_split']
];
const original = new Map(await Promise.all(files.map(async (file) => [file, await readFile('/app/' + file, 'utf8')])));
const digest = (source) => createHash('sha256').update(source).digest('hex');
function execute(args) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000,
    maxBuffer: 8 * 1024 * 1024 });
}
const results = [];
try {
  await mkdir(root, { recursive: true });
  for (const folder of ['src', 'public']) await cp('/app/' + folder, root + '/' + folder, { recursive: true });
  for (const name of ['node_modules', 'migrations', 'test-artifacts']) await symlink('/app/' + name, root + '/' + name);
  await cp('/app/package.json', root + '/package.json');
  for (const file of tests) {
    await mkdir(root + '/' + file.slice(0, file.lastIndexOf('/')), { recursive: true });
    await cp('/app/' + file, root + '/' + file);
  }
  for (const [name, file, before, after] of mutants) {
    const source = original.get(file);
    assert.ok(source.includes(before), name + ' mutation anchor');
    await writeFile(root + '/' + file, source.replace(before, after));
    try {
      const result = execute(['--test', '--test-concurrency=1', ...tests]);
      const log = (result.stdout || '') + (result.stderr || '');
      await writeFile(`${out}/mutant-${name}.log`, log);
      assert.equal(result.signal, null, name + ' must fail assertions, not time out');
      assert.notEqual(result.status, 0, name + ' survived');
      assert.match(log, /AssertionError|Property failed/, name + ' requires behavioral failure');
      const properties = execute(['--test', '--test-concurrency=1', '--test-name-pattern=property', ...tests]);
      await writeFile(`${out}/mutant-property-${name}.log`, (properties.stdout || '') + (properties.stderr || ''));
      results.push({ name, killed: true, propertyKilled: properties.status !== 0,
        failures: [...log.matchAll(/^not ok \d+ - (.*)$/gmu)].map((match) => match[1]) });
    } finally {
      await writeFile(root + '/' + file, source);
      assert.equal(digest(await readFile(root + '/' + file, 'utf8')), digest(source));
    }
  }
  const restored = execute(['--test', '--test-concurrency=1', ...tests]);
  await writeFile(`${out}/mutation-restored.log`, (restored.stdout || '') + (restored.stderr || ''));
  assert.equal(restored.status, 0, 'Restored implementation must pass');
  await writeFile(`${out}/mutations.json`, JSON.stringify({ killed: results.length, total: mutants.length, results }, null, 2) + '\n');
  console.log(JSON.stringify({ killed: results.length, total: mutants.length, propertyKilled: results.filter((row) => row.propertyKilled).length }));
} finally {
  for (const [file, source] of original) assert.equal(digest(await readFile('/app/' + file, 'utf8')), digest(source));
  await rm(root, { recursive: true, force: true });
}
