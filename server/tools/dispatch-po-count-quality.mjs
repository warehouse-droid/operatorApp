import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import istanbulCoverage from 'istanbul-lib-coverage';
const { createCoverageMap } = istanbulCoverage;

const run=(args,name,options={})=>{
  const result=spawnSync('node',args,{encoding:'utf8',timeout:120000,maxBuffer:24*1024*1024,...options});
  writeFileSync(`test-artifacts/${name}.log`,result.stdout+result.stderr);
  return result;
};
const tests=['test/dispatch/unit/dispatch-po-count.test.js','test/dispatch/integration/dispatch-po-count.test.js','test/dispatch/unit/dispatch-group-member-po.test.js'];
if(!process.env.PO_COUNT_SKIP_CORE_COVERAGE) assert.equal(run(['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false','--include=src/dispatch-repository.js',
  '--reporter=json','--report-dir=test-artifacts/count-coverage','--temp-directory=/tmp/count-coverage',
  'node','--test','--test-concurrency=1',...tests],'count-coverage').status,0);
const browser='test/dispatch/frontend/dispatch-link-dialog-stability.browser.test.mjs';
assert.equal(run(['--test',browser],'dialog-coverage',{env:{...process.env,PO_COUNT_COVERAGE:'1'}}).status,0);
const changes=JSON.parse(readFileSync('test-artifacts/changed-lines.json','utf8'));
const coverageResults=[];
for(const [file,report] of [['src/dispatch-repository.js','count-coverage'],['public/dispatch.js','link-dialog']]) {
  const map=createCoverageMap(JSON.parse(readFileSync(`test-artifacts/${report}/coverage-final.json`,'utf8')));
  const lines=map.fileCoverageFor(`/app/${file}`).getLineCoverage();
  const changed=changes[file].filter(line=>Object.hasOwn(lines,line));
  const covered=changed.filter(line=>lines[line]>0);
  const result={file,changedExecutableLines:changed.length,covered:covered.length,percent:100*covered.length/changed.length,
    uncovered:changed.filter(line=>!lines[line])};
  coverageResults.push(result);console.log(JSON.stringify(result));
  assert.ok(result.percent>=95,'Changed executable line coverage must reach 95%');
}
writeFileSync('test-artifacts/changed-line-coverage.json',JSON.stringify(coverageResults,null,2));

const source=readFileSync('public/dispatch.js','utf8');
const mutations=[
 ['replace-popup','if (preserveActiveLink && ["po-link", "to-link"].includes(modalType)','if (false && ["po-link", "to-link"].includes(modalType)'],
 ['reload-background-options','// Background feeds update the board, not an in-progress linking form.',
   'if (modalType === "po-link") loadPoAllocationOptions(modalOrderId); else if (modalType === "to-link") loadOrderDependencyOptions(orderById(modalOrderId));']
];
const killed=[];
for(const [name,before,after] of mutations) {
  assert.equal(source.split(before).length,2);
  const root=`/tmp/po-count-ui-mutant-${name}`;
  try {
    mkdirSync(`${root}/public`,{recursive:true});mkdirSync(`${root}/test/dispatch/frontend`,{recursive:true});
    for(const entry of readdirSync('public')) if(entry!=='dispatch.js') symlinkSync(`/app/public/${entry}`,`${root}/public/${entry}`);
    writeFileSync(`${root}/public/dispatch.js`,source.replace(before,after));
    cpSync(browser,`${root}/${browser}`);cpSync('package.json',`${root}/package.json`);
    symlinkSync('/app/node_modules',`${root}/node_modules`,'dir');
    const result=run(['--test',browser],name,{cwd:root});
    assert.equal(result.status,1);assert.match(result.stdout,/ERR_ASSERTION/u);
    assert.match(result.stdout,/must not replace the popup/u);
    killed.push({name,detected:true});console.log(JSON.stringify({mutation:name,detected:true}));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync('test-artifacts/ui-mutations.json',JSON.stringify(killed,null,2));
