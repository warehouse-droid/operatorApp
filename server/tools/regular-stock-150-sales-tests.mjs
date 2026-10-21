import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {regularTests,neighbors} from './regular-stock-v2-suites.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const baseline=process.argv.includes('--baseline'),out='test-artifacts';
mkdirSync(out+'/suite',{recursive:true});
const legacy=JSON.parse(readFileSync('package.json')).scripts['test:stock-requests'].split(' ').filter(arg=>arg.endsWith('.js'));
const files=[...new Set([...regularTests,...legacy,...neighbors])].filter(file=>!baseline || !file.includes('regular-stock-150-sales')).sort();
const expected=JSON.parse(readFileSync('tools/regular-stock-v2-baseline-failures.json'));
const screenshotName='desktop and phone Resolve require PO and ETA, retain the reply through refresh, and close both Stocking types';
const screenshotError='locator.screenshot: Element is not attached to the DOM';
const baselineScreenshotPath=out+'/resolution-baseline-browser.log';
const screenshotProof=existsSync(baselineScreenshotPath)?readFileSync(baselineScreenshotPath,'utf8'):'';
const results=[];let passed=0;
for (const [index,file] of files.entries()) {
  const child=spawnSync(process.execPath,['--test',file],{encoding:'utf8',maxBuffer:20_000_000,timeout:120000});
  const output=(child.stdout||'')+(child.stderr||'');
  writeFileSync(`${out}/suite/${baseline?'baseline':'final'}-${index}.tap`,output);
  const failures=[...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  passed+=[...output.matchAll(/^# pass (\d+)/gm)].reduce((sum,match)=>sum+Number(match[1]),0);
  const knownScreenshot=file==='test/mbt/integration/regular-stock-resolution-browser.test.js'
    && failures.length===1 && failures[0]===screenshotName && output.includes(screenshotError)
    && screenshotProof.includes(screenshotError) && screenshotProof.includes('not ok 1 - '+screenshotName);
  const known=child.status===1 && (Boolean(expected[file]) && output.includes(expected[file]) || knownScreenshot);
  const row={file,exitCode:child.status,signal:child.signal,failures,knownFixtureFailure:known,
    newFailures:child.status===0 || known?[]:failures.length?failures:['Process failure']};
  results.push(row);writeFileSync(`${out}/${baseline?'baseline':'final'}-tests.json`,JSON.stringify({passed,results},null,2));
  console.log(JSON.stringify({file,exitCode:child.status,knownFixtureFailure:known}));
}
const newFailures=results.flatMap(row=>row.newFailures);
const summary={files:files.length,passed,baselineFixtureFailures:results.filter(row=>row.knownFixtureFailure).length,newFailures};
writeFileSync(`${out}/${baseline?'baseline':'final'}-tests-summary.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));assert.deepEqual(newFailures,[],'No new regression failures');
