import { readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from '../test/support/test-database-isolation.mjs';

const mode = process.argv[2];
if (!['baseline', 'final'].includes(mode)) { throw new Error('baseline or final required'); }
async function testFiles(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { files.push(...await testFiles(name)); }
    else if (/\.test\.(?:js|mjs)$/u.test(name)) { files.push(name); }
  }
  return files;
}
async function killTree(root) {
  const parents = new Map();
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/u.test(name))) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      parents.set(Number(pid), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* A process may exit while its metadata is read. */ }
  }
  const selected = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (selected.has(parent) && !selected.has(pid)) { selected.add(pid); changed = true; }
    }
  }
  for (const pid of [...selected].reverse()) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
}
async function runFile(file, environment) {
  return new Promise((resolve, reject) => {
    const started = Date.now(), child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', file],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    }
    const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const counts = [...output.matchAll(/^ℹ tests (\d+)$/gmu)];
      const failures = [...new Set([...output.matchAll(/^✖ (.*?) \([\d.]+ms\)$/gmu)].map(match => match[1]))];
      if (timedOut) { failures.push('__file_timeout_120s__'); console.log(`Test file timeout: ${file}`); }
      resolve({ file, exitCode: code ?? 1, signal, timedOut, milliseconds: Date.now() - started, tests: Number(counts.at(-1)?.[1] || 0), failures });
    });
  });
}
const databaseUrl = process.env.DATABASE_URL;
const sourceNames = ['transfer-order-posting-domain.js', 'transfer-order-posting-repository.js', 'transfer-order-posting-service.js',
  'receiving-repository.js', 'delivery-repository.js', 'server.js', 'order-sync-repository.js', 'netsuite.js'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceNames.map(async name => [`src/${name}`, createHash('sha256').update(await readFile(`src/${name}`)).digest('hex')])));
await writeFile(`test-artifacts/operator-to-yard-flow/full-${mode}-source-hashes.json`, JSON.stringify(sourceHashes, null, 2) + '\n');
const boundary = describeIsolatedTestDatabase(databaseUrl, process.env);
const admin = new pg.Client({ connectionString: boundary.adminUrl });
const files = (await testFiles('test/mbt')).filter(file => !file.includes('/e2e/') && (mode !== 'baseline' || !file.includes('operator-to-yard-flow')));
const runId = randomUUID(), results = [];
await admin.connect();
try {
  for (const [index, file] of files.entries()) {
    const name = isolatedTestDatabaseName(runId, index);
    console.log(`\n[isolation] full-${mode} ${index + 1}/${files.length} ${file}`);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='mbt_test' AND pid<>pg_backend_pid()");
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE mbt_test`);
    try {
      results.push(await runFile(file, { ...process.env, DATABASE_URL: isolatedTestDatabaseUrl(databaseUrl, name) }));
      await writeFile(`test-artifacts/operator-to-yard-flow/full-${mode}-results.json`, JSON.stringify(results, null, 2) + '\n');
    } finally { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
  }
} finally { await admin.end(); }
const failed = results.filter(result => result.exitCode !== 0);
console.log(JSON.stringify({ mode, files: results.length, tests: results.reduce((sum, r) => sum + r.tests, 0), failedFiles: failed.map(r => r.file) }));
process.exitCode = failed.length ? 1 : 0;
