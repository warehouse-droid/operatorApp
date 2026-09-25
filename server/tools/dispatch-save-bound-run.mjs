// Bind an entire completed tool/suite run to the runtime source it exercised.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const [name, executable, ...args] = process.argv.slice(2);
assert.match(name, /^[a-z][a-z0-9-]*$/);
assert.ok(executable);
const files = ['src/dispatch-plan-fence.js', 'src/dispatch-plan-write.js', 'src/dispatch-plan-lease-repository.js',
  'src/dispatch-plan-repository.js', 'src/dispatch-planner-performance.js', 'src/dispatch-planner-v2-repository.js',
  'src/scm-dependency-preview-service.js', 'src/scm-dependency-command-service.js', 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js',
  'src/server.js', 'public/dispatch.js', 'public/dispatch-save-journal.js', 'public/dispatch-snapshot.js',
  'public/dispatch.css', 'public/dispatch.html', 'public/dispatch-snapshot.html'];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, await readFile(file).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(() => null)])));
const report = { name, command: [executable, ...args], startedAt: new Date().toISOString(), sources: await hashes(), node: process.version };
report.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(executable, args, { env: process.env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => signal ? reject(new Error(`Run terminated: ${signal}`)) : resolve(code));
});
assert.deepEqual(await hashes(), report.sources, 'Runtime source changed during the run');
report.completedAt = new Date().toISOString();
await writeFile(`test-artifacts/dispatch-save-reliability/${name}-sources.json`, JSON.stringify(report, null, 2));
process.exitCode = report.exitCode;
