import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
const folder=process.env.FIELD_SALES_ARTIFACT_DIR;
const coverage={...JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`)),...JSON.parse(readFileSync(`${folder}/ui-coverage/coverage-final.json`))};
const runtime=JSON.parse(readFileSync('tools/field-sales-quote-memo-files.json'));
function changedLines(before,after){
  const a=before.split('\n'),b=after.split('\n'),dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--){for(let j=b.length-1;j>=0;j--){dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);}}
  let i=0,j=0;const added=[];
  while(j<b.length){if(i<a.length&&a[i]===b[j]){i++;j++;}else if(i<a.length&&dp[i+1][j]>dp[i][j+1]){i++;}else{added.push(++j);}}
  return added;
}
const results=[],unmeasured=[];
for(const file of runtime.filter(name=>name.endsWith('.js')&&!name.endsWith('/service-worker.js'))){
  const data=coverage[`/app/${file}`];if(!data){unmeasured.push(file);continue;}
  const before=existsSync('/baseline/'+file)?readFileSync('/baseline/'+file,'utf8'):'',after=readFileSync(file,'utf8');
  const executable=new Map();for(const [key,range] of Object.entries(data.statementMap)){for(let line=range.start.line;line<=range.end.line;line++){executable.set(line,Math.max(executable.get(line)||0,data.s[key]));}}
  const changed=changedLines(before,after).filter(line=>executable.has(line)&&after.split('\n')[line-1].trim()&&!after.split('\n')[line-1].trim().startsWith('//'));
  const missed=changed.filter(line=>!executable.get(line));results.push({file,changed:changed.length,covered:changed.length-missed.length,missed});
}
const report={results,unmeasured,passed:results.every(r=>!r.missed.length)};
writeFileSync(`${folder}/changed-lines.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.equal(report.passed,true,'Changed executable lines must be covered.');
