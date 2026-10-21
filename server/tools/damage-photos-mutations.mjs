import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,symlinkSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const out=resolve('test-artifacts/damage-photos-20261001'),results=[];
const mutants=[
  {name:'lost-review-priority',file:'src/control-damage-router.js',from:"router.get('/review',operatorNetSuitePriority,handler",to:"router.get('/review',handler",test:'damage-photos-priority'},
  {name:'foreign-transfer',file:'src/inventory-damage-photo-links.js',from:'String(report.transfer_id)===String(transfer.id)',to:'true',test:'damage-photo-links'},
  {name:'ambiguous-line',file:'src/inventory-damage-photo-links.js',from:'lines.length!==1',to:'lines.length<1',test:'damage-photo-links'},
  {name:'duplicate-photo',file:'public/damage-photo-download.js',from:'!reference || references.has(reference)',to:'!reference',test:'damage-photo-download'},
  {name:'wrong-line-name',file:'public/damage-photo-download.js',from:"String(line.line).padStart(3,'0')",to:"String(1).padStart(3,'0')",test:'damage-photo-download'}
];
for(const mutant of mutants) {
  const root=mkdtempSync(join(tmpdir(),'damage-photo-mutant-'));
  try {
    for(const folder of ['src','public']) {cpSync(folder,join(root,folder),{recursive:true});}
    mkdirSync(join(root,'test/support'),{recursive:true});
    copyFileSync(`test/${mutant.test}.test.js`,join(root,`test/${mutant.test}.test.js`));
    copyFileSync('test/support/control-damage-schema.sql',join(root,'test/support/control-damage-schema.sql'));
    copyFileSync('package.json',join(root,'package.json'));
    symlinkSync('/app/node_modules',join(root,'node_modules'),'dir');
    const target=join(root,mutant.file),source=readFileSync(target,'utf8');
    assert.equal(source.split(mutant.from).length,2,mutant.name+' anchor');
    writeFileSync(target,source.replace(mutant.from,mutant.to));
    const run=spawnSync(process.execPath,['--test',`test/${mutant.test}.test.js`],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
    const log=run.stdout+run.stderr;
    writeFileSync(join(out,`mutation-${mutant.name}.log`),log);
    const killed=run.status===1 && /# fail [1-9]/.test(log) && /AssertionError|Property failed/.test(log);
    results.push({name:mutant.name,killed});
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync(join(out,'mutations.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results));assert.ok(results.every(row=>row.killed));
