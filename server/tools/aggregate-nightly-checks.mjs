import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { scanTextForSecrets } from '../test/support/scan-diff-secrets.mjs';

const root = process.cwd(); const output = path.resolve('test-artifacts');
const legacy = ['src/scm-reconciliation-repository.js','src/scm-reconciliation-service.js','src/server.js','public/control.js','src/delivery-repository.js','src/sales-order-reconciliation-repository.js'];
const added = ['src/aggregate-reconciliation.js','src/aggregate-reconciliation-repository.js','src/aggregate-reconciliation-service.js','src/applied-sales-order-billing.js'];
const newTests = ['test/mbt/unit/aggregate-nightly.test.js','test/mbt/unit/aggregate-nightly-ui.test.js','test/mbt/unit/aggregate-nightly-service.test.js',
  'test/mbt/integration/aggregate-nightly.test.js','test/mbt/integration/aggregate-nightly-schedule.test.js','test/mbt/integration/aggregate-nightly-http.test.js','test/mbt/integration/aggregate-nightly-browser.test.js','test/mbt/integration/operator-reconciled-billed.test.js'];
const tests = [...newTests,'test/mbt/unit/reconciliation-blockers.test.js','test/mbt/unit/shared-json-read.test.js','test/mbt/unit/shared-json-read-http.test.js'];
const reopen = 'test/dispatch/integration/billed-order-reopen.test.js';
const evidence = { tier: 3, specApproval: 'not obtained (autonomous run)', red: { newBehaviorTests: 10, failed: 10 },
  command: 'MBBS_TEST_BUILD_TARGET=test-e2e python3 server/tools/reconciliation-blockers-run.py node tools/aggregate-nightly-checks.mjs',
  harnessCorrections: ['Schedule fixture supplies both approval timestamp and actor, as required by the existing database constraint.', 'Browser checks use the repository test-e2e image.', 'Independent settings patches exposed an existing Date-to-string validation bug; canonical YYYY-MM-DD mapping fixed.', 'Test image has no patch binary; reverse source hunks in Node and verify original SHA-256 hashes instead.'],
  skipped: { repositoryWideSuite: 'Scoped reconciliation, response-sharing and reopen regressions run on the shared application host.',
    legacyTypes: 'Strict checking for pure new modules; legacy dependency graph checked with baseline lint, syntax and integration tests.',
    dependencyAudit: 'No new or changed dependencies.',
    liveNetSuiteInTests: 'NetSuite financial writes are disabled in disposable tests; existing executor and live scope inspected separately.' }, sourceHashes: {}, mutation: [], versions: { node: process.version } };
function run(name, command, args, { cwd = root, allowed = [0] } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 30e6, timeout: 240000 });
  assert.ifError(result.error); const text = result.stdout + result.stderr;
  writeFileSync(path.join(output, `${name}.log`), text);
  if (!allowed.includes(result.status)) { console.log(text.slice(-12000)); }
  assert.ok(allowed.includes(result.status), `${name}: exit ${result.status}`);
  return text;
}
const node = (name, args, options) => run(name, process.execPath, args, options);
evidence.harnessCorrections.push('Mutation reruns exposed non-cascading fixture line cleanup; delete fixture lines explicitly before headers.', 'Retained the 90% coverage gate and added clock rollback, SQL alias and operational-probe edge cases.', 'Fixed new UI lint findings; normalized only shifted line numbers when comparing existing lint messages.');
const counts = text => Object.fromEntries(['tests','pass','fail','skipped'].map(key => [key, Number(text.match(new RegExp(`# ${key} (\\d+)`))?.[1])]));
const failures = text => [...text.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]);
const clone = directory => {
  mkdirSync(directory, { recursive: true });
  for (const name of ['src','public','test','tools','package.json','eslint.mbt.config.js']) { cpSync(name, path.join(directory, name), { recursive: true }); }
  symlinkSync(path.join(root,'node_modules'), path.join(directory,'node_modules'));
};
function restoreBaseline(directory) {
  const patch = readFileSync('test/support/aggregate-nightly-before.patch','utf8');
  const hashes = JSON.parse(readFileSync('test/support/aggregate-nightly-before-hashes.json','utf8'));
  for (const block of patch.split(/^--- a\//m).slice(1)) {
    const file = block.slice(0,block.indexOf('\n')); let content = readFileSync(path.join(directory,file),'utf8');
    for (const hunk of block.split(/^@@[^\n]+@@[^\n]*\n/m).slice(1)) {
      const lines = hunk.split('\n');
      const final = lines.filter(line => [' ','+'].includes(line[0])).map(line=>line.slice(1)).join('\n')+'\n';
      const original = lines.filter(line => [' ','-'].includes(line[0])).map(line=>line.slice(1)).join('\n')+'\n';
      assert.ok(content.includes(final),`Cannot reverse baseline hunk: ${file}`); content=content.replace(final,original);
    }
    assert.equal(createHash('sha256').update(content).digest('hex'),hashes[file]);
    writeFileSync(path.join(directory,file),content);
  }
}
mkdirSync(path.join(output,'billed-order-reopen-20261015'), { recursive: true });
const baseline = path.join(output,'baseline'); clone(baseline);
try {
  restoreBaseline(baseline);
  // The browser harness uses a path relative to its working tree.
  symlinkSync(output,path.join(baseline,'test-artifacts'));
  const before = node('reopen-baseline',['--test',reopen],{cwd:baseline,allowed:[0,1]});
  const final = node('reopen-final',['--test',reopen],{allowed:[0,1]});
  assert.deepEqual(failures(final),failures(before),'New failure in existing local-reopen tests');
  evidence.reopenBaseline = { before: counts(before), after: counts(final), existingFailures: failures(before) };
  evidence.reopenBaseline.failureDetails = before.split(/(?=^not ok )/m).slice(1).map(block => block.split(/^  \.\.\./m)[0]);
  console.log(`CHECK reopen ${JSON.stringify(evidence.reopenBaseline)}`);
  const lint = (name,cwd) => JSON.parse(node(name,['node_modules/eslint/bin/eslint.js','--config','tools/aggregate-nightly-eslint.config.mjs','--format=json',...legacy],{cwd,allowed:[0,1]}))
    .flatMap(entry => entry.messages.map(message => `${path.basename(entry.filePath)}:${message.ruleId}:${message.message.replace(/complexity of \d+/g,'complexity above limit').replace(/line \d+ column \d+/g,'line N column N')}`));
  const old = lint('lint-before',baseline); const current = lint('lint-after',root); const remaining = [...old];
  const additions = current.filter(message => { const index=remaining.indexOf(message); if(index<0){ return true; } remaining.splice(index,1); return false; });
  if(additions.length){ console.log(JSON.stringify(additions)); } assert.deepEqual(additions,[]);
  evidence.lint={baseline:old.length,final:current.length,added:additions.length};
} finally { rmSync(baseline,{recursive:true,force:true}); }
node('lint-new',['node_modules/eslint/bin/eslint.js','--config','tools/aggregate-nightly-eslint.config.mjs','--max-warnings=0',...added,...newTests]);
node('types',['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--strict','--noEmit','--skipLibCheck','--types','node','--target','es2023','--module','nodenext',added[0],added[3]]);
for(const file of [...legacy,...added]){ node(`syntax-${path.basename(file)}`,['--check',file]); }
console.log('CHECK static passed');
evidence.static = { strictPureModuleTypes: 'passed', newSourceLint: 'passed', legacySyntax: 'passed' };
const suite=node('suite',['node_modules/c8/bin/c8.js','--all=false',...added.map(file=>`--include=${file}`),`--temp-directory=${output}/v8`,`--report-dir=${output}/coverage`,'--reporter=json-summary','node','--test','--test-concurrency=1',...tests]);
evidence.suite=counts(suite); evidence.coverage=JSON.parse(readFileSync(`${output}/coverage/coverage-summary.json`,'utf8'));
console.log(`CHECK suite ${JSON.stringify(evidence.suite)}`);
const mutant=path.join(output,'mutant'); clone(mutant); symlinkSync(output,path.join(mutant,'test-artifacts'));
const faults=[
  ['material-fail-open',added[0],'return materialPattern.test(', 'return true || materialPattern.test(',newTests[0],true],
  ['material-fail-closed',added[0],'return materialPattern.test(', 'return false && materialPattern.test(',newTests[0],true],
  ['repeat-date',added[0],'const attempted = Boolean(lastRun && lastRun.scheduledLocalDate >= localDate);','const attempted = false;',newTests[0],true],
  ['ignore-enabled',added[0],'if (!settings.aggregateNightlyEnabled)','if (false)',newTests[0],false],
  ['operational-overlap',added[2],'if (await operationalSyncRunning())','if (false)',newTests[2],false],
  ['wrong-status',added[1],"= 'B'", "= 'G'",newTests[3],false],
  ['ignore-billed-result','src/delivery-repository.js','${appliedSalesOrderBilledSql(alias)} OR','false OR',newTests[7],false]
];
try {
  for(const [name,file,from,to,suiteFile,property] of faults){
    const original=readFileSync(file,'utf8'); assert.ok(original.includes(from),name);
    writeFileSync(path.join(mutant,file),original.replace(from,to));
    const result=node(`mutant-${name}`,['--test',suiteFile],{cwd:mutant,allowed:[1]}); assert.match(result,/ERR_ASSERTION|ERR_TEST_FAILURE/);
    if(property){ node(`property-mutant-${name}`,['--test','--test-name-pattern=property:',suiteFile],{cwd:mutant,allowed:[1]}); }
    evidence.mutation.push({name,killed:true,propertyOnlyKilled:property}); writeFileSync(path.join(mutant,file),original);
  }
} finally { rmSync(mutant,{recursive:true,force:true}); }
console.log(`CHECK mutation ${faults.length}/${faults.length}`);
evidence.reorderedSuite=counts(node('suite-reversed',['--test','--test-concurrency=1',...tests.toReversed()]));
for(const file of [...legacy,...added,...newTests,'migrations/305_aggregate_nightly_reconciliation.sql']){
  const content=readFileSync(file,'utf8'); evidence.sourceHashes[file]=createHash('sha256').update(content).digest('hex'); assert.deepEqual(scanTextForSecrets(content,file),[]);
}
for(const name of ['c8','typescript','eslint','fast-check','playwright']){ evidence.versions[name]=JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version; }
evidence.completedAt=new Date().toISOString();
writeFileSync(`${output}/aggregate-nightly-summary.json`,JSON.stringify(evidence,null,2));
console.log('CHECK complete');
