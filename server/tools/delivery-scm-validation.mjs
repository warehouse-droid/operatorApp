import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
const reports = [];
mkdirSync('test-artifacts/combined-release', {recursive:true});
function stage(label, args, options = {}) {
  const started = Date.now();
  const run = spawnSync(process.execPath, args, {encoding:'utf8', timeout:900000,
    maxBuffer:32 * 1024 * 1024, ...options});
  writeFileSync(`test-artifacts/combined-release/${label}.log`, `${run.stdout || ''}${run.stderr || ''}`);
  reports.push({label, exitCode:run.status, seconds:(Date.now() - started) / 1000, error:run.error?.message || null});
  writeFileSync('test-artifacts/combined-release/stages.json', JSON.stringify(reports, null, 2) + '\n');
  console.log(JSON.stringify(reports.at(-1)));
  assert.equal(run.status, 0, `${label}: inspect its retained log`);
}
const manifest = JSON.parse(readFileSync('tools/delivery-scm-candidate.json', 'utf8'));
for (const name of manifest.files.filter(name => name.endsWith('.js'))) {
  const run = spawnSync(process.execPath, ['--check', name], {encoding:'utf8'});
  assert.equal(run.status, 0, `${name}: ${run.stderr}`);
}
stage('delivery-focused', ['tools/delivery-request-checks.mjs']);
stage('delivery-types', ['tools/delivery-request-quality.mjs', 'types']);
stage('delivery-lint', ['tools/delivery-request-static.mjs']);
stage('tool-versions', ['tools/delivery-request-quality.mjs', 'versions']);
// Mutate only a throwaway copy on the container's bounded tmpfs.
const sandbox = mkdtempSync(path.join(tmpdir(), 'delivery-scm-mutations-'));
try {
  for (const name of ['src','public','test']) cpSync(name, path.join(sandbox, name), {recursive:true});
  cpSync('package.json', path.join(sandbox, 'package.json'));
  for (const name of ['tools','node_modules','test-artifacts']) {
    symlinkSync(path.resolve(name), path.join(sandbox, name), 'dir');
  }
  stage('delivery-mutations', ['tools/delivery-request-mutations.mjs'], {cwd:sandbox});
} finally {rmSync(sandbox, {recursive:true, force:true});}
stage('scm-gauntlet', ['tools/scm-ultimate-packing-final.mjs']);
writeFileSync('test-artifacts/combined-release/result.json', JSON.stringify({passed:true,
  candidateTreeHash:manifest.candidateTreeHash, changedRuntimeFiles:manifest.files.length,
  stages:reports}, null, 2) + '\n');
console.log(JSON.stringify({passed:true, candidateTreeHash:manifest.candidateTreeHash}));
