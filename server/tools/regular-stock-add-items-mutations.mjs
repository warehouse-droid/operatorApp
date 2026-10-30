import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const file = 'public/regular-stock-request-actions.js', source = readFileSync(file, 'utf8');
const suite = 'test/mbt/property/regular-stock-add-items.property.test.js';
const mutants = [
  ['allow-linked-SO', 'regular.salesOrderId || regular.salesOrderRef ||', ''],
  ['keep-approved', 'automatic: false', 'automatic: true'],
  ['keep-expiry', 'approvalExpiresAt: null', 'approvalExpiresAt: regular.approvalExpiresAt'],
  ['keep-line-waiting', '[id, {...state, replyStatus: null}]', '[id, {...state}]'],
  ['allow-processed-item', "['submitted', 'approved', 'changes_requested', 'rejected'].includes(line.status)", 'true']
];
const root = resolve(mkdtempSync('test-artifacts/add-items-mutants-')), results = [];
try {
  mkdirSync(`${root}/public`, {recursive: true});
  mkdirSync(`${root}/test/mbt/property`, {recursive: true});
  cpSync('package.json', `${root}/package.json`); cpSync(suite, `${root}/${suite}`);
  symlinkSync('/app/node_modules', `${root}/node_modules`);
  for (const [name, from, to] of mutants) {
    if (source.split(from).length !== 2) throw new Error(`Mutation anchor mismatch: ${name}`);
    writeFileSync(`${root}/${file}`, source.replace(from, to));
    const run = spawnSync(process.execPath, ['--test', suite], {cwd: root, encoding: 'utf8', timeout: 30000});
    const output = run.stdout + run.stderr;
    const killed = run.status !== 0 && /AssertionError|Property failed/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output);
    results.push({name, killed, suite: 'property'});
    if (!killed) console.log(output);
  }
} finally { rmSync(root, {recursive: true, force: true}); }
if (readFileSync(file, 'utf8') !== source) throw new Error('Mutation changed application source');
writeFileSync('test-artifacts/regular-stock-add-items-mutations.json', JSON.stringify(results));
console.log(JSON.stringify(results));
if (results.some(row => !row.killed)) process.exitCode = 1;
