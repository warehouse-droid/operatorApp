import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, 'false');
const dir = 'tools/special-status-following-20261005';
const out = resolve('test-artifacts/special-status-following-20261005');
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (!name.startsWith('red-')) rmSync(out + '/' + name, { recursive: true, force: true });
const own = 'test/mbt/unit/special-status-following.test.js';
const ownTests = [own,'test/mbt/unit/special-logistics-progress.test.js'];
const sources = ['src/special-stock-status-refresh.js', 'src/special-stock-logistics.js', 'src/server.js', 'src/special-stock-request-repository.js',
  'public/special-stock-case-status.js', 'public/special-stock-queue.js', 'public/scm-special-stock-requests.js', 'public/sales-special-stock-requests.js'];
const existing = readdirSync('test/mbt/unit').filter(name => /^special.*\.test\.js$/.test(name) && !ownTests.some(path=>path.endsWith('/'+name)))
  .sort().map(name => 'test/mbt/unit/' + name);
const sha = value => createHash('sha256').update(value).digest('hex');
const counts = log => Object.fromEntries(['tests','pass','fail','skipped'].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0)]));
const failureNames = log => [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]);
function run(label, command, args, cwd = '/app') {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 40000000 });
  const log = (result.stdout || '') + (result.stderr || '');
  writeFileSync(`${out}/${label}.log`, log);
  assert.ok(result.status !== null, label + ': ' + result.error);
  console.log(JSON.stringify({ label, exit: result.status, ...counts(log) }));
  return { status: result.status, log, counts: counts(log), failures: failureNames(log) };
}
function copyTree(target) {
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const name of ['src','public','test','tools','migrations']) cpSync(name, target + '/' + name, { recursive: true });
  for (const name of ['package.json','netsuite-smart-scm-picking-ticket-restlet.js']) cpSync(name, target + '/' + name);
  symlinkSync('/app/node_modules', target + '/node_modules'); return target;
}
const baselineRoot = copyTree('/tmp/special-status-baseline');
for (const source of sources) cpSync(dir + '/baseline/' + source, baselineRoot + '/' + source);
cpSync(dir + '/baseline/test/mbt/unit/special-stock-updates.test.js',baselineRoot + '/test/mbt/unit/special-stock-updates.test.js');
const baseline = run('baseline', process.execPath, ['--test','--test-concurrency=1',...existing], baselineRoot);
const red = run('red-final', process.execPath, ['--test',...ownTests], baselineRoot);
assert.equal(red.status, 1); assert.ok(red.failures.some(name => name.startsWith('SPREQ-000024')));
const coverage = run('regressions', '/app/node_modules/.bin/c8', ['--all=false','--check-coverage=false',
  '--temp-directory=' + out + '/c8','--report-dir=' + out + '/coverage','--reporter=json','--reporter=text',
  ...sources.map(name => '--include=' + name), process.execPath,'--test','--test-concurrency=1',...existing,...ownTests]);
const newFailures = coverage.failures.filter(name => !baseline.failures.includes(name));
assert.deepEqual(newFailures, []);
const focused = run('focused', process.execPath, ['--test',...ownTests]); assert.equal(focused.status, 0);

const lint = new ESLint({ overrideConfigFile: resolve('tools/special-workflow-native-eslint.config.mjs') });
const lintFiles = [...sources,...ownTests,'test/mbt/integration/special-status-following.test.js',dir + '/gauntlet.mjs',dir + '/db_gauntlet.mjs',dir+'/browser-check.mjs',dir+'/browser-coverage.mjs',dir+'/verify-live.mjs'];
const lintResults = await lint.lintFiles(lintFiles);
writeFileSync(out + '/lint.json', JSON.stringify(lintResults, null, 2));
const baselineLint = new ESLint({ cwd:baselineRoot,overrideConfigFile:resolve('tools/special-workflow-native-eslint.config.mjs') });
const lintBase = await baselineLint.lintFiles(sources.filter(name=>!['src/special-stock-status-refresh.js','src/special-stock-logistics.js'].includes(name)));
const lintDiagnostics = results=>results.flatMap(result=>result.messages.map(message=>({file:result.filePath.split('/public/').pop().split('/src/').pop(),rule:message.ruleId,message:message.message})));
const beforeLint = lintDiagnostics(lintBase).map(value=>JSON.stringify(value));
const newLint = lintDiagnostics(lintResults).filter(value=>!beforeLint.includes(JSON.stringify(value)));
writeFileSync(out + '/lint-delta.json',JSON.stringify({baseline:beforeLint.length,patched:lintDiagnostics(lintResults).length,newLint}));
assert.deepEqual(newLint,[]);
for (const source of sources) assert.equal(run('syntax-' + source.replaceAll('/','-'),process.execPath,['--check',source]).status,0);
const typeArgs = ['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext',...sources];
const typeBase = run('types-baseline','/app/node_modules/.bin/tsc',typeArgs,baselineRoot);
const types = run('types','/app/node_modules/.bin/tsc',typeArgs);
const diagnostics = log => log.split('\n').filter(line => line.includes('error TS')).map(line => line.replace(/\(\d+,\d+\)/g,'')).sort();
const baseDiagnostics = diagnostics(typeBase.log), newDiagnostics = diagnostics(types.log).filter(line => !baseDiagnostics.includes(line));
writeFileSync(out + '/type-delta.json',JSON.stringify({baseline:baseDiagnostics.length,patched:diagnostics(types.log).length,newDiagnostics}));
assert.deepEqual(newDiagnostics,[]);

const root = copyTree('/tmp/special-status-mutants');
const mutants = [
  ['refresh-fresh-cache','src/special-stock-status-refresh.js','age < MAX_AGE_MS','age < 0'],
  ['wrong-order-id','src/special-stock-status-refresh.js','...order, status:','...order, netsuiteOrderId: order.netsuiteOrderId + 1, status:'],
  ['accept-foreign-ref','src/special-stock-status-refresh.js','row.tranid === order.tranid','true'],
  ['old-status-priority','src/special-stock-status-refresh.js','canonical || row.sales_order_status','row.sales_order_status || canonical'],
  ['invert-local-completion','public/special-stock-case-status.js',"if (detail.operationallyComplete) return progress('SO delivery: Delivered'","if (!detail.operationallyComplete) return progress('SO delivery: Delivered'"]
];
const mutations = [];
for (const [name,file,from,to] of mutants) {
  const original = readFileSync(file,'utf8');
  assert.ok(original.includes(from),name);
  writeFileSync(root + '/' + file,original.replace(from,to));
  const full = run('mutation-' + name,process.execPath,['--test',...ownTests],root);
  const property = run('property-mutation-' + name,process.execPath,['--test','--test-name-pattern=property:',...ownTests],root);
  assert.equal(full.status,1,name + ' survived'); assert.equal(property.status,1,name + ' survived properties');
  writeFileSync(root + '/' + file,original);
  mutations.push({name,killed:true,propertyKilled:true});
}
const health = run('suite-health',process.execPath,['--test','--test-concurrency=1',...ownTests,...existing.toReversed()]);
assert.deepEqual(health.failures.toSorted(),coverage.failures.toSorted());
const files = [...sources,...ownTests,'test/mbt/integration/special-status-following.test.js','test/special-status-following-spec.md',
  dir + '/gauntlet.mjs',dir + '/db_gauntlet.mjs',dir+'/browser-check.mjs',dir+'/browser-coverage.mjs',dir+'/verify-live.mjs',dir + '/run.py',dir + '/run_db.py',dir+'/coverage.py',dir+'/deploy.py'];
const secrets = run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...files]); assert.equal(secrets.status,0);
const summary = { baseline:baseline.counts,baselineFailures:baseline.failures,regressions:coverage.counts,newFailures,focused:focused.counts,red:red.counts,
  types:{baseline:baseDiagnostics.length,patched:diagnostics(types.log).length,new:0},lint:'pass',mutations,suiteHealth:health.counts,
  properties:{count:6,examplesEach:100},manifest:Object.fromEntries(sources.map(name => [name,sha(readFileSync(name))])),
  tools:Object.fromEntries(['typescript','eslint','c8','fast-check','v8-to-istanbul','istanbul-lib-coverage'].map(name=>[name,JSON.parse(readFileSync('/app/node_modules/' + name + '/package.json')).version])) };
writeFileSync(out + '/summary.json',JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary));
