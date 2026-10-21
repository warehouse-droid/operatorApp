import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from '../test/support/test-database-isolation.mjs';

const artifact = 'test-artifacts/operator-if-static-lines';
const mode = process.argv[2];
assert.ok(['baseline', 'final', 'shuffled'].includes(mode));
await mkdir(artifact, { recursive: true });
async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { result.push(...await filesIn(path)); }
    else if (/\.test\.(?:js|mjs)$/u.test(path)) { result.push(path); }
  }
  return result;
}
const component = /operator-netsuite-posting|operator-posting-rounding|operator-if-static-lines|operator-posting-pack-quantities|operator-posting-photos|operator-direct-orderline|operator-kit|operator-yard-access|operator-ui-enhancements|customer-pickup|pickup-existing-if|child-location|load-followup|transfer-order-background-posting|operator-to-yard-flow|to-linked-so-completion|operator-po-receipt|direct-po|direct-ship-posting|sales-order-auto-fulfillment|netsuite-transaction-units/u;
const files = (await filesIn('test/mbt')).filter(file => component.test(file) && !file.includes('/e2e/')
  && (mode !== 'baseline' || !/operator-if-static-lines/u.test(file))).sort();
if (mode === 'shuffled') {
  let seed = 10159;
  for (let index = files.length - 1; index > 0; index--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [files[index], files[other]] = [files[other], files[index]];
  }
}
const boundary = describeIsolatedTestDatabase(process.env.DATABASE_URL, process.env);
const admin = new pg.Client({ connectionString: boundary.adminUrl });
const results = [], runId = randomUUID();
await admin.connect();
try {
  for (const [index, file] of files.entries()) {
    const name = isolatedTestDatabaseName(runId, index);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='mbt_test' AND pid<>pg_backend_pid()");
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE mbt_test`);
    try {
      const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file],
        { env: { ...process.env, DATABASE_URL: isolatedTestDatabaseUrl(process.env.DATABASE_URL, name),
          ...(mode === 'final' ? { NODE_V8_COVERAGE: resolve(`${artifact}/coverage/tmp`) } : {}) },
          encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
      const log = (run.stdout || '') + (run.stderr || '');
      const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]);
      if (run.error) { failures.push(String(run.error.code)); }
      const counts = Object.fromEntries(['tests', 'pass', 'fail'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'mu'))?.[1] || 0)]));
      const result = { file, exitCode: run.status ?? 1, ...counts, failures };
      results.push(result);
      await writeFile(`${artifact}/${mode}-${index}.log`, log);
      await writeFile(`${artifact}/${mode}.json`, JSON.stringify(results, null, 2) + '\n');
      console.log(JSON.stringify({ mode, index: index + 1, of: files.length, ...result }));
    } finally { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
  }
} finally { await admin.end(); }
if (mode !== 'baseline') {
  const baseline = JSON.parse(await readFile(`${artifact}/baseline.json`, 'utf8'));
  const known = new Map(baseline.map(result => [result.file, result]));
  const newFailures = results.flatMap(result => {
    const old = known.get(result.file);
    const failures = result.failures.filter(failure => !old?.failures.includes(failure));
    if (result.exitCode !== 0 && !failures.length && old?.exitCode === 0) { failures.push('unexpected file failure'); }
    return failures.map(failure => ({ file: result.file, failure }));
  });
  const report = { mode, files: results.length, tests: results.reduce((sum, result) => sum + result.tests, 0),
    passed: results.reduce((sum, result) => sum + result.pass, 0), failedFiles: results.filter(result => result.exitCode !== 0).length,
    baselineFailedFiles: baseline.filter(result => result.exitCode !== 0).length, newFailures };
  await writeFile(`${artifact}/${mode}-summary.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  process.exitCode = newFailures.length ? 1 : 0;
}
