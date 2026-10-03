import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

const diff=fs.readFileSync(process.argv[2],'utf8');
const reviewed=JSON.parse(fs.readFileSync(new URL('./production-snapshot-secret-review-20261003.json',import.meta.url),'utf8'));
const lines=new Map();let file='',number=0;
for(const line of diff.split('\n')){
 if(line.startsWith('+++ b/')){file=line.slice(6);continue;}
 const hunk=/^@@ -[^+]*\+(\d+)/.exec(line);
 if(hunk){number=Number(hunk[1]);continue;}
 if(line.startsWith('+')&&!line.startsWith('+++')){
  lines.set(file+':'+number,crypto.createHash('sha256').update(line.slice(1)).digest('hex'));number++;
 }else if(!line.startsWith('-'))number++;
}
const findings=scanUnifiedDiff(diff);
const unresolved=findings.filter(f=>!reviewed.some(r=>r.file===f.file&&r.line===f.line&&r.kind===f.kind&&r.lineSha256===lines.get(f.file+':'+f.line)));
console.log(JSON.stringify({findings:findings.length,reviewedFalsePositives:findings.length-unresolved.length,unresolved},null,2));
assert.equal(unresolved.length,0,'Unreviewed secret-scan finding; values intentionally omitted');
