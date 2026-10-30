// Retain a concise verification record; raw output stays in the disposable run.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

function fingerprint(root) {
  const hash = createHash('sha256');
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) hash.update(path).update('\0').update(readFileSync(path));
    }
  }
  visit(root);
  return hash.digest('hex');
}
const startedAt = new Date().toISOString();
const sourceHashes = Object.fromEntries(['src', 'public', 'migrations'].map(path => [path, fingerprint(path)]));
const child = spawn(process.execPath, ['tools/mbt-uat-suites.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...(process.argv.length > 2 ? { MBT_UAT_FILES: JSON.stringify(process.argv.slice(2)) } : {}) }
});
let output = '', pending = '';
child.stdout.on('data', value => {
  output += value;
  pending += value;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines) if (line.startsWith('[isolation]')) console.log(line);
});
child.stderr.on('data', value => { output += value; });
child.on('error', error => { throw error; });
const exitCode = await new Promise(resolve => child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 1)));
writeFileSync('test-artifacts/mbt-uat.log', output);
const files = [];
for (const section of output.split(/(?=\[isolation\])/u)) {
  const match = section.match(/^\[isolation\] mbt-uat \d+\/\d+ (.+)/u);
  if (!match) continue;
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name =>
    [name, Number([...section.matchAll(new RegExp(`^ℹ ${name} (\\d+)$`, 'gmu'))].at(-1)?.[1] ?? 0)]));
  const names = [...section.matchAll(/^[✔✖﹣] (.+?)(?: \([\d.]+ms\))?$/gmu)].map(item => item[1]);
  const failureAt = section.indexOf('✖ failing tests:');
  const failure = failureAt >= 0 ? section.slice(failureAt).split('\n').filter(line => !line.includes('matcherResult:')).join('\n').slice(0, 10000) : null;
  files.push({ file: match[1], ...counts, names, ...(failure ? { failure } : {}) });
  if (failure) console.log(`${match[1]}\n${failure}`);
}
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name =>
  [name, files.reduce((sum, file) => sum + file[name], 0)]));
const sourceDrift = Object.keys(sourceHashes).filter(path => fingerprint(path) !== sourceHashes[path]);
const report = {
  startedAt, finishedAt: new Date().toISOString(), exitCode, sourceHashes, sourceDrift,
  isolation: 'Disposable Compose; fresh database per file; external integrations disabled',
  toolchain: { node: process.version, playwright: JSON.parse(readFileSync('node_modules/playwright/package.json', 'utf8')).version },
  ...counts, fileCount: files.length, files,
  passed: exitCode === 0 && files.length > 0 && counts.tests > 0 && counts.pass === counts.tests && !counts.skipped && !counts.cancelled && !sourceDrift.length
};
writeFileSync('test-artifacts/mbt-uat-results.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...counts, fileCount: files.length, exitCode, sourceDrift, passed: report.passed }));
if (!report.passed) process.exitCode = 1;
