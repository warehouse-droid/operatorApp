import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
const modes=process.argv.slice(2);
for(const mode of modes.length?modes:['static','coverage','reverse','mutations']) {
  console.log(`Starting partial receipt checks: ${mode}`);
  const result=spawnSync(process.execPath,['tools/partial-linked-posting-checks.mjs',mode],
    {encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
  const output=(result.stdout||'')+(result.stderr||'');
  fs.writeFileSync(`test-artifacts/partial-${mode}.log`,output);
  const line=output.split('\n').find(value=>value.startsWith('PARTIAL_POSTING_REPORT '));
  const report=line?JSON.parse(line.slice('PARTIAL_POSTING_REPORT '.length)):{};
  if(result.signal || result.error) {report.runnerError=String(result.error || result.signal);}
  report.failures=[...new Set([...output.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(match=>match[1]))];
  const counts=[...output.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)];
  const totals={};for(const [,name,value] of counts) {totals[name]=(totals[name]||0)+Number(value);}
  report.totals=totals;
  const baseline=JSON.parse(fs.readFileSync('test/partial-linked-posting-baseline.json','utf8'));
  const testMode=['baseline','tests','focused','coverage','reverse'].includes(mode);
  report.newFailures=testMode?report.failures.filter(name=>!baseline.failures.includes(name)):[];
  const coveragePass=mode!=='coverage' || (report.coverage && !report.coverage.misses.length);
  const knownFailures=line && testMode && report.exit===1 && coveragePass && totals.fail===report.failures.length
    && report.failures.length>0 && !report.newFailures.length;
  console.log(`PARTIAL_POSTING_REPORT ${JSON.stringify(report)}`);
  if((result.status!==0 && !knownFailures) || !coveragePass) {
    if(mode!=='baseline') {
      for(const name of report.newFailures) {const start=output.indexOf(`✖ ${name}`);console.error(output.slice(start,start+5000));}
      if(!report.newFailures.length) {console.error(output.slice(-6000));}
    }
    process.exitCode=1;break;
  }
}
