import {spawnSync} from 'node:child_process';
import {regularTests,neighbors} from './regular-stock-v2-suites.mjs';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out='test-artifacts/regular-stock-v2';mkdirSync(out,{recursive:true});
const legacy=JSON.parse(readFileSync('package.json')).scripts['test:stock-requests'].split(' ').filter(arg=>arg.endsWith('.js'));
const suite=[...regularTests,...legacy,...neighbors],reversed=process.argv.includes('--reverse');
const baseline=JSON.parse(readFileSync('tools/regular-stock-v2-baseline-failures.json'));
const results=[];let output='';
for(const files of reversed?[...suite].reverse().map(file=>[file]):[suite]){
 const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{encoding:'utf8',maxBuffer:20_000_000});
 const text=result.stdout+result.stderr;output+=text;
 const failures=[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
 const known=failures.every(name=>{const file=name.replace(/^\/app\//,'');return baseline[file]&&text.includes(baseline[file]);});
 const accepted=result.status===0||result.status===1&&failures.length>0&&known;
 results.push({files,exitCode:result.status,knownFailures:known?failures:[],newFailures:accepted?[]:failures.length?failures:['Unexpected process failure']});
}
writeFileSync(`${out}/${reversed?'reverse':'tests'}.tap`,output);
writeFileSync(`${out}/${reversed?'reverse':'tests'}-results.json`,JSON.stringify(results,null,2));
const pass=[...output.matchAll(/^# pass (\d+)/gm)].reduce((sum,match)=>sum+Number(match[1]),0);
const expected=results.flatMap(result=>result.knownFailures).length,newFailures=results.flatMap(result=>result.newFailures);
console.log(JSON.stringify({passed:pass,baselineFixtureFailures:expected,newFailures,reversed}));
assert.deepEqual(newFailures,[],'No new regression failures');
