import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { query, closeDb } from '../../src/db.js';
const out = 'test-artifacts/special-status-following-20261005';
function run(label, command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 30000000 });
  writeFileSync(`${out}/${label}.log`, (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.status, 0, label + ': ' + result.stderr);
  return result;
}
run('db-migrations', process.execPath, ['src/migrate.js']);
const baseline='/tmp/special-status-db-baseline';
rmSync(baseline,{recursive:true,force:true});mkdirSync(baseline,{recursive:true});
for(const name of ['src','public','test','migrations'])cpSync(name,baseline+'/'+name,{recursive:true});
for(const name of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js'])cpSync(name,baseline+'/'+name);
symlinkSync('/app/node_modules',baseline+'/node_modules');
const sources=Object.keys(JSON.parse(readFileSync(out+'/summary.json')).manifest);
for(const name of sources)cpSync('tools/special-status-following-20261005/baseline/'+name,baseline+'/'+name);
const red=spawnSync(process.execPath,['--test','test/mbt/integration/special-status-following.test.js'],{cwd:baseline,encoding:'utf8',timeout:90000});
writeFileSync(out+'/red-db.log',(red.stdout||'')+(red.stderr||''));assert.equal(red.status,1);
assert.match(red.stdout,/# fail 7\b/);
try{await query('DROP SCHEMA public CASCADE');await query('CREATE SCHEMA public');}finally{await closeDb();}
run('db-migrations-final',process.execPath,['src/migrate.js']);
const coverageArgs = ['--all=false','--check-coverage=false','--reporter=json','--reporter=text',
  '--temp-directory=' + out + '/db-c8','--report-dir=' + out + '/db-coverage',
  '--include=src/special-stock-status-refresh.js','--include=src/server.js','--include=src/special-stock-request-repository.js',
  '--include=src/special-stock-logistics.js',
  process.execPath,'--test','--test-concurrency=1','test/mbt/integration/special-stock-request-http.red.test.js',
  'test/mbt/integration/special-workflow-polish-http.test.js','test/mbt/integration/special-status-following.test.js'];
run('db-checks', '/app/node_modules/.bin/c8', coverageArgs);
const log = readFileSync(out + '/db-checks.log', 'utf8');
const counts = Object.fromEntries(['tests','pass','fail','skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
writeFileSync(out + '/db-summary.json', JSON.stringify(counts));
console.log(JSON.stringify(counts));
run('browser-checks',process.execPath,['tools/special-status-following-20261005/browser-check.mjs']);
run('browser-coverage',process.execPath,['tools/special-status-following-20261005/browser-coverage.mjs']);
