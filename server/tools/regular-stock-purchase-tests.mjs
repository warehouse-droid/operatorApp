import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {regularTests,neighbors} from './regular-stock-v2-suites.mjs';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-purchase';await mkdir(out,{recursive:true});
const legacy=JSON.parse(await readFile('package.json','utf8')).scripts['test:stock-requests'].split(' ').filter(arg=>arg.endsWith('.js'));
const known=JSON.parse(await readFile('tools/regular-stock-v2-baseline-failures.json','utf8'));
const suite=[...new Set([...regularTests,...legacy,...neighbors])];
const seed=Number(process.env.REGULAR_PURCHASE_SUITE_SEED)||0;
if(seed){
  let state=seed>>>0;
  for(let index=suite.length-1;index>0;index--){state=(Math.imul(state,1664525)+1013904223)>>>0;const other=state%(index+1);[suite[index],suite[other]]=[suite[other],suite[index]];}
}
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...suite],{encoding:'utf8',maxBuffer:30_000_000});
const output=result.stdout+result.stderr;
await writeFile(`${out}/regression.log`,output);
const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
const newFailures=failures.filter(name=>!known[name.replace(/^\/app\//,'')]||!output.includes(known[name.replace(/^\/app\//,'')]));
const summary={files:suite.length,tests:Number(/# tests (\d+)/.exec(output)?.[1]),passed:Number(/# pass (\d+)/.exec(output)?.[1]),baselineFailures:failures.filter(name=>!newFailures.includes(name)),newFailures,exitCode:result.status,seed};
await writeFile(`${out}/regression.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
assert.deepEqual(newFailures,[],'No new regression failures');
assert(result.status===0||result.status===1&&failures.length>0,'Unexpected test runner failure');
