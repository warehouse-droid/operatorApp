import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const out='test-artifacts/delivery-yard-access-20261007';
const files=JSON.parse(readFileSync('tools/delivery-yard-access-20261007/files.json'));
const entries=Object.values(JSON.parse(readFileSync(out+'/coverage/coverage-final.json')));
const browser=readdirSync(out+'/browser').filter(file=>file.startsWith('coverage-')&&file.endsWith('.json')).flatMap(file=>JSON.parse(readFileSync(out+'/browser/'+file)));
const changed=[],missing=[];
for(const file of files.filter(name=>name.endsWith('.js'))){
  const source=readFileSync(file,'utf8'),lines=source.split('\n');
  const diff=spawnSync('diff',['-U0','tools/delivery-yard-access-20261007/baseline/'+file,file],{encoding:'utf8'}).stdout;
  let line=0;
  for(const text of diff.split('\n')){
    const hunk=text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if(hunk){line=Number(hunk[1]);continue;}
    if(text.startsWith('+')&&!text.startsWith('+++')){
      const value=lines[line-1],trim=value.trim();
      if(trim&&!/^\/\/|^\/\*|^\*|^[{});]+$/.test(trim)){
        const matched=entries.filter(entry=>entry.path===process.cwd()+'/'+file);
        const executed=matched.some(entry=>Object.entries(entry.statementMap).some(([key,span])=>span.start.line<=line&&span.end.line>=line&&entry.s[key]>0));
        const offset=lines.slice(0,line-1).join('\n').length+(line>1?1:0)+value.indexOf(trim);
        const hit=browser.filter(entry=>entry.url.split('?')[0].endsWith('/'+file.split('/').at(-1))&&entry.source===source).some(entry=>
          entry.functions.flatMap(fn=>fn.ranges).filter(range=>range.startOffset<=offset&&range.endOffset>offset).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset))[0]?.count>0);
        changed.push(file+':'+line);if(!executed&&!hit)missing.push(file+':'+line);
      }
      line++;
    }else if(!text.startsWith('-')&&!text.startsWith('\\'))line++;
  }
}
const result={total:changed.length,covered:changed.length-missing.length,missing,changed};
writeFileSync(out+'/changed-coverage.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.deepEqual(missing,[]);
