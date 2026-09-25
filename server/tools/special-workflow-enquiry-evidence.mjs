import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import coverage from 'istanbul-lib-coverage';
const output=process.env.SPECIAL_WORKFLOW_OUTPUT || 'test-artifacts/special-workflow-enquiry/final';
const files=JSON.parse(await readFile('test/special-workflow-enquiry-changed-lines.json','utf8'));
const measured=JSON.parse(await readFile(`${output}/coverage/coverage-final.json`,'utf8'));
const result={files:{},covered:0,total:0};
for(const [file,source]of Object.entries(files)) {
  if(createHash('sha256').update(await readFile(file)).digest('hex')!==source.afterSha256)throw new Error(`Coverage source changed: ${file}`);
  const data=Object.entries(measured).find(([path])=>path.endsWith('/'+file))?.[1];
  if(!data)throw new Error(`Coverage missing: ${file}`);
  const lines=coverage.createFileCoverage(data).getLineCoverage();
  const changed=source.changedLines.filter(line=>Object.hasOwn(lines,line));
  const uncovered=changed.filter(line=>!lines[line]);
  result.files[file]={covered:changed.length-uncovered.length,total:changed.length,uncovered};
  result.covered+=changed.length-uncovered.length;result.total+=changed.length;
}
result.percent=100*result.covered/result.total;
await writeFile(`${output}/changed-line-coverage.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));

if(result.covered!==result.total)throw new Error("Changed lines are missing execution evidence");
