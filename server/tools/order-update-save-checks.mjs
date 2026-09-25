import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { runtimeFiles, migrationFiles, assetFiles } from './order-update-save-files.mjs';
import { mutants } from '../test/support/order-update-save-mutations.mjs';

const directory = 'test-artifacts/order-update-save';
await mkdir(directory, { recursive: true });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(await Promise.all([...runtimeFiles, ...migrationFiles, ...assetFiles].map(async file => [file, hash(await readFile(file))])));
async function run(name, args, { env = {}, fail = false } = {}) {
  const result = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = result.stdout + result.stderr;
  await writeFile(`${directory}/${name}.log`, output);
  if (fail) {
    assert.notEqual(result.status, 0, `${name} survived`);
    assert.match(output, /ERR_ASSERTION/, `${name} did not fail a behavioral assertion: ${output.slice(-2000)}`);
    assert.doesNotMatch(output, /Invalid mutation anchor|ERR_MODULE_NOT_FOUND|SyntaxError/);
  } else assert.equal(result.status, 0, `${name}: ${output.slice(-5000)}`);
  console.log(JSON.stringify({ check: name, exitCode: result.status }));
}
await rm(`${directory}/v8`, { recursive: true, force: true });
await rm(`${directory}/coverage`, { recursive: true, force: true });
await run('focused-coverage', ['node_modules/c8/bin/c8.js', '--all=false', '--check-coverage=false',
  ...runtimeFiles.map(file => `--include=${file}`), `--report-dir=${directory}/coverage`, `--temp-directory=${directory}/v8`,
  '--reporter=json', '--reporter=text', 'node', 'tools/order-update-save-suites.mjs', 'focused']);
const kills = [];
for (const name of Object.keys(mutants)) {
  const env = { ORDER_UPDATE_SAVE_MUTANT: name, NODE_OPTIONS: '--experimental-loader=./test/support/order-update-save-mutations.mjs' };
  await run(`mutant-${name}`, ['tools/order-update-save-suites.mjs', 'focused'], { env, fail: true });
  await run(`property-mutant-${name}`, ['tools/order-update-save-suites.mjs', 'properties'], { env, fail: true });
  kills.push(name);
}
await run('focused-reversed', ['tools/order-update-save-suites.mjs', 'focused', 'reverse']);
for (const file of runtimeFiles) await run(`syntax-${file.replaceAll('/', '-')}`, ['--check', file]);
for (const file of Object.keys(sources)) assert.equal(hash(await readFile(file)), sources[file], `${file} changed during checks`);
await writeFile(`${directory}/checks.json`, JSON.stringify({ sources, kills, propertyKills: kills, node: process.version, completedAt: new Date().toISOString() }, null, 2));
