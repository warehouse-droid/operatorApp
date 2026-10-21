import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const results={};
for(const [label,directory] of [['before','/baseline'],['candidate','/candidate']]) {
  const audit=spawnSync('npm',['audit','--omit=dev','--json'],{cwd:directory,encoding:'utf8',timeout:120000});
  try {results[label]=JSON.parse(audit.stdout);}catch {throw new Error('The dependency audit could not be read for '+label);}
}
const ids=result=>new Set(Object.values(result.vulnerabilities??{}).flatMap(row=>row.via.filter(item=>typeof item==='object').map(item=>item.source)));
const before=ids(results.before),after=ids(results.candidate),newAdvisories=[...after].filter(id=>!before.has(id));
results.newAdvisories=newAdvisories;results.licenses=['playwright: Apache-2.0','playwright-core: Apache-2.0'];
fs.writeFileSync('/output/dependency-audit.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({before:results.before.metadata?.vulnerabilities,candidate:results.candidate.metadata?.vulnerabilities,newAdvisories,licenses:results.licenses}));
if(newAdvisories.length) {process.exitCode=1;}
