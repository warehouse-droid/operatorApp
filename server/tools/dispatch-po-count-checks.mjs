import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isolatedRun } from './dispatch-source-decision-checks.mjs';

const integration = 'test/dispatch/integration/dispatch-po-count.test.js';
const unit = 'test/dispatch/unit/dispatch-po-count.test.js';
const files = [integration,unit,
  'test/dispatch/unit/dispatch-group-member-po.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js',
  'test/dispatch/unit/dispatch-po-route-residual.red.test.js',
  'test/dispatch/unit/dispatch-po-line-destinations.test.js',
  'test/dispatch/integration/dispatch-po-pickup-yard.test.js',
  'test/dispatch/integration/dispatch-required-pickups-save.test.js',
  'test/dispatch/integration/dispatch-po-split-link-target.test.js',
  'test/dispatch/frontend/dispatch-group-pickup-card.test.js',
  'test/dispatch/frontend/scm-dependency-atomic-ui.red.test.js',
  'test/dispatch/frontend/dispatch-link-dialog-stability.browser.test.mjs',
  'test/dispatch/unit/dispatch-activity-allocation-scope.test.js',
  'test/dispatch/unit/dispatch-executed-order-review.test.js'];
const results=[];
for (const file of files) {
  const result=await isolatedRun(file,{prefix:'po-count'});
  results.push(result); console.log(JSON.stringify(result));
}
writeFileSync('test-artifacts/regressions.json',JSON.stringify(results,null,2));
assert.ok(results.every(result=>result.exit===0),'Regression failure');
for(const file of ['src/dispatch-repository.js','public/dispatch.js','tools/dispatch-po-count-repair.mjs',unit,integration]) {
  assert.equal(spawnSync('node',['--check',file],{stdio:'inherit'}).status,0);
}
const lint=spawnSync('node',['node_modules/eslint/bin/eslint.js','--config','eslint.mbt.config.js','src/dispatch-repository.js','public/dispatch.js'],{encoding:'utf8'});
writeFileSync('test-artifacts/lint.log',lint.stdout+lint.stderr);
assert.equal(lint.status,0,'Lint failed');

const source=readFileSync('src/dispatch-repository.js','utf8');
const mutations=[
  ['ignore-count-link','if (!isMbbsSpecialLine(item) && !countPieces) return explicit;','if (!isMbbsSpecialLine(item)) return explicit;'],
  ['allow-other-units','/^(EACH|EA|PCS|PC|PIECES?)$/u.test(String(item.unit || "").trim().toUpperCase())','true'],
  ['leak-sibling-manifest','if (candidate !== order && !matchesCandidate(candidate, allocation)) continue;','if (false) continue;'],
  ['omit-child-manifest','return applyItems(order);','const result = applyItems(order); for (const child of result.childOrderDetails || []) { delete child.poPickupManifest; child.pickupLocations = [child.sourceYard]; } return result;']
];
const killed=[];
for(const [name,before,after] of mutations) {
  assert.equal(source.split(before).length,2,`Unique mutant: ${name}`);
  const root=`/tmp/po-count-mutant-${name}`;
  try {
    mkdirSync(root,{recursive:true});
    cpSync('src',`${root}/src`,{recursive:true});
    cpSync('package.json',`${root}/package.json`);
    for(const file of [unit,integration,'test/support/dispatch-po-line-destination-functions.mjs','tools/dispatch-po-count-repair.mjs']) {
      mkdirSync(`${root}/${file.slice(0,file.lastIndexOf('/'))}`,{recursive:true});
      cpSync(file,`${root}/${file}`);
    }
    symlinkSync('/app/node_modules',`${root}/node_modules`,'dir');
    symlinkSync('/app/public',`${root}/public`,'dir');
    writeFileSync(`${root}/src/dispatch-repository.js`,source.replace(before,after));
    const file=['ignore-count-link','allow-other-units'].includes(name)?unit:integration;
    const result=await isolatedRun(file,{cwd:root,prefix:name});
    assert.equal(result.exit,1,`Mutant ${name} must fail assertions`);
    assert.ok(result.failures.length,`Mutant ${name} must be behaviorally detected`);
    assert.ok(result.failures.every(failure=>!failure.includes('.test.js')),`Mutant ${name} must reach assertions`);
    killed.push({name,...result}); console.log(JSON.stringify({mutation:name,...result}));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync('test-artifacts/mutations.json',JSON.stringify(killed,null,2));
console.log(JSON.stringify({passed:true,files:files.length,tests:results.reduce((sum,r)=>sum+(r.tests||0),0),mutantsKilled:killed.length}));
await import('./dispatch-po-count-quality.mjs');
