import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {regularTests,neighbors} from './regular-stock-v2-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const mode=process.argv[2];
const legacy=JSON.parse(readFileSync('package.json')).scripts['test:stock-requests'].split(' ').filter(arg=>arg.endsWith('.js'));
const suite=[...regularTests.filter(file=>mode==='final'||process.argv.includes('--include-kit-red')||!file.includes('regular-stock-kit')), ...legacy,...neighbors];
if(process.argv.includes('--shuffle')){
 let seed=121863;
 for(let index=suite.length-1;index>0;index--){
  seed=(seed*1664525+1013904223)>>>0;
  const target=seed%(index+1);[suite[index],suite[target]]=[suite[target],suite[index]];
 }
}
const batches=process.argv.includes('--shuffle')?suite.map(file=>[file]):[suite];
const runs=batches.map(files=>spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{encoding:'utf8',maxBuffer:40_000_000}));
const output=runs.map(result=>result.stdout+result.stderr).join('\n');
const label=process.argv.includes('--shuffle')?'random-order':'regressions';
writeFileSync('test-artifacts/'+label+'.tap',output);
const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const total=label=>[...output.matchAll(new RegExp('^# '+label+' (\\d+)','gm'))].reduce((sum,match)=>sum+Number(match[1]),0);
const summary={tests:total('tests'),passed:total('pass'),failures,exitCode:runs.every(result=>result.status===0)?0:1,
 orderSeed:process.argv.includes('--shuffle')?121863:null};
writeFileSync('test-artifacts/'+label+'.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
assert(runs.every(result=>result.status===0 || result.status===1),'Unexpected test runner failure');
if(mode==='final'){
 const baseline=JSON.parse(readFileSync('tools/regular-stock-kit-baseline-tests.json'));
 const allowed=process.argv.includes('--shuffle')?[...baseline.failures,...(baseline.randomFailures||[])]:baseline.failures;
 assert.deepEqual(failures.filter(name=>!allowed.includes(name)),[],'New regression failures');
}
