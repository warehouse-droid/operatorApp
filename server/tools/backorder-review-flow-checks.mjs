import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {sourceHashes,staticChecks,mutations,coverage} from './backorder-review-flow-quality.mjs';

export const fresh=[
  'test/mbt/unit/backorder-review-flow.test.js',
  'test/mbt/integration/backorder-review-flow.test.js',
  'test/mbt/integration/backorder-review-flow-browser.test.js'
];
export const regressions=[
  'test/mbt/unit/backorder-workflow.test.js',
  'test/mbt/property/backorder-link-sequence.property.test.js',
  'test/mbt/property/backorder-po-recheck.property.test.js',
  'test/mbt/property/backorder-already-ordered.property.test.js',
  'test/mbt/integration/backorder-requests.test.js',
  'test/mbt/integration/backorder-already-ordered.test.js',
  'test/mbt/integration/already-ordered-arrival.test.js',
  'test/mbt/integration/already-ordered-arrival-integrity.test.js',
  'test/mbt/integration/already-ordered-arrival-browser.test.js',
  'test/mbt/integration/backorder-browser.test.js',
  'test/mbt/integration/backorder-enhancements-browser.test.js',
  'test/mbt/integration/backorder-already-ordered-browser.test.js',
  'test/mbt/integration/special-transfer-eta-browser.test.js'
];
const out='/app/test-artifacts/backorder-review';mkdirSync(out,{recursive:true});
const report={at:new Date().toISOString(),node:process.version};
export function suite(label,files,extra=[],cover=true) {
  const log=`${out}/${label}.log`,fd=openSync(log,'w');
  let result;
  const env={...process.env};
  if(cover) {env.NODE_V8_COVERAGE=out+'/v8';mkdirSync(env.NODE_V8_COVERAGE,{recursive:true});}
  else delete env.NODE_V8_COVERAGE;
  try {result=spawnSync(process.execPath,['--test','--test-concurrency=1',...extra,...files],{stdio:['ignore',fd,fd],env,timeout:600000});}
  finally {closeSync(fd);}
  const text=readFileSync(log,'utf8');
  const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(name=>[name,Number(text.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1])]));
  assert(Number.isSafeInteger(counts.tests)&&counts.tests>0,`${label} did not finish: ${text.slice(-4000)}`);
  const failures=[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  const errors=[...text.matchAll(/^not ok \d+ - (.+)\n([\s\S]*?)(?=^# Subtest:|^ok \d+ - |^not ok \d+ - |^1\.\.|$(?![\s\S]))/gm)].map(match=>{
    const detail=match[2].match(/\n  error: ([\s\S]*?)(?=\n  \w)/)?.[1]?.trim()||'';
    return {test:match[1],error:detail.replace(/^\|-\s*/,'').split('\n')[0].trim(),detail:detail.slice(0,900)};
  });
  const summary={...counts,failures,errors,exit:result.status};console.log(JSON.stringify({label,...counts,failures,exit:result.status}));
  if(counts.fail && !label.startsWith('mutant')) console.log(text.slice(-2200));
  return summary;
}
function fingerprint(row) {
  return [row.error,row.detail.match(/Locator: ([^\n]+)/)?.[1]||row.detail.match(/- waiting for ([^\n]+)/)?.[1]||'',
    row.detail.match(/assert\.\w+\([^\n]+/)?.[0]||''].join('\n');
}
const mode=process.argv[2]||'final';
try {
  if(mode==='baseline') {
    report.baseline=suite('baseline',regressions);
    report.red=suite('red',fresh);
    assert(report.red.fail>0,'New behavior should fail before implementation');
  } else {
    report.sourceHashes=sourceHashes();
    report.static=staticChecks(fresh);
    report.fresh=suite('new-behavior',fresh);
    assert.equal(report.fresh.fail,0,'New behavior failed; inspect the disposable run output');
    assert.equal(report.fresh.exit,0);assert.equal(report.fresh.cancelled,0);assert.equal(report.fresh.skipped,0);
    report.coverage=await coverage();
    console.log(JSON.stringify({coverage:report.coverage}));
    assert(report.coverage.every(row=>row.uncovered.length===0),'Uncovered changed executable lines');
    report.mutations=mutations(suite);
    if(mode!=='quick') {
      report.regressions=suite('regressions',regressions);
      const baseline=JSON.parse(readFileSync('test/backorder-review-flow-baseline-errors.json','utf8'));
      const unexpected=report.regressions.errors.filter(row=>!baseline.some(old=>old.test===row.test && fingerprint(old)===fingerprint(row)));
      assert.equal(report.regressions.errors.length,report.regressions.failures.length);
      assert.deepEqual(unexpected,[],'New or changed regression failures');
      report.reordered=[];
      report.fileOrder=[...fresh].sort();let seed=165186;
      for(let i=report.fileOrder.length-1;i>0;i--) {
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);
        [report.fileOrder[i],report.fileOrder[j]]=[report.fileOrder[j],report.fileOrder[i]];
      }
      if(report.fileOrder.join() === [...fresh].sort().join()) report.fileOrder.push(report.fileOrder.shift());
      for(const file of report.fileOrder) {
        const result=suite('reordered-'+report.reordered.length,[file]);assert.equal(result.fail,0);report.reordered.push(result);
      }
    }
    assert.deepEqual(sourceHashes(),report.sourceHashes,'Source changed during checks');
    report.newFailures=0;report.passed=true;
  }
} finally {writeFileSync('/app/test-artifacts/backorder-review-report.json',JSON.stringify(report,null,2)+'\n');}
