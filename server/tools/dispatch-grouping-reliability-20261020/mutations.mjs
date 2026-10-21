import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = mkdtempSync('/tmp/edit-group-mutants-');
const browser = 'test/dispatch/frontend/edit-group-reliability.browser.test.mjs';
const integration = 'test/dispatch/integration/edit-group-reliability.test.js';
const property = 'test/dispatch/frontend/group-hydration-concurrency.test.js';
const mutations = [
  ['invalidate-unrelated-events', 'public/dispatch.js',
    '!relatedRefs.length || relatedRefs.some(ref => dispatchGroupHydrationRefs.has(ref))', 'true', property],
  ['inherit-split-parent', 'public/dispatch.js',
    'id: uniqueGroupedDispatchOrderId(leafItems),\n    originalOrderId: "",',
    'id: uniqueGroupedDispatchOrderId(leafItems),\n    originalOrderId: groupItems[0].originalOrderId,', browser],
  ['persist-group-as-split', 'src/dispatch-delivery-group-repository.js',
    'if (isGroupedDispatchOrder(order)) return "";', 'if (false) return "";', integration],
  ['download-full-ownership', 'src/dispatch-planner-v2-repository.js',
    '${includeSnapshots ? "assignment.assignment" : "(assignment.assignment - \'plannedOrderSnapshot\')"} AS assignment',
    'assignment.assignment AS assignment', integration],
  ['omit-incomplete-retry', 'public/dispatch.js', 'if (attempt < 2) continue;', 'if (false) continue;', property]
];
try {
  for (const name of ['src', 'public', 'test', 'package.json'])
    cpSync(name, root + '/' + name, { recursive: true });
  symlinkSync(resolve('node_modules'), root + '/node_modules');
  const results = [];
  for (const [name, file, before, after, testFile] of mutations) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.split(before).length, 2, name);
    writeFileSync(root + '/' + file, source.replace(before, after));
    const run = propertyOnly => {
      const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
        ...(propertyOnly ? ['--test-name-pattern=property:'] : []), propertyOnly ? property : testFile],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      const log = result.stdout + result.stderr;
      writeFileSync(`test-artifacts/mutant-${name}${propertyOnly ? '-property' : ''}.log`, log);
      return { killed: result.status === 1 && /^not ok /m.test(log),
        exit: result.status, failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
    };
    const result = run(false), propertyOnly = run(true);
    writeFileSync(root + '/' + file, source);
    assert.ok(result.killed, name + ': ' + JSON.stringify(result));
    results.push({ name, ...result, propertyOnly });
    console.log(JSON.stringify(results.at(-1)));
  }
  const hashes = Object.fromEntries([...new Set(mutations.map(row => row[1]))].map(file =>
    [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  writeFileSync('test-artifacts/mutations.json', JSON.stringify({ mutations: results, hashes }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
