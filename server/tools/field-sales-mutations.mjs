import { readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const source=readFileSync('public/field-sales/domain.js','utf8');
const mutants=[
  ['fractional line truncation','+ SCALE * SCALE / 2n','+ 0n'],
  ['tax truncation','+ 5000n','+ 0n'],
  ['grand total excludes tax','safeMinor(subtotalMinor + taxMinor)','safeMinor(subtotalMinor)'],
  ['zero quantity accepted','positive && n === 0n','positive && n < 0n'],
  ['existing Sales bypass',"['admin','field_sales'].includes", "['admin','field_sales','sales'].includes"]
];
mkdirSync('test-artifacts',{recursive:true});
const directory=mkdtempSync(join(process.cwd(),'test-artifacts/field-sales-mutants-')),results=[];
try {
  for(const [name,from,to] of mutants) {
    if(!source.includes(from)){throw new Error(`Mutant anchor missing: ${name}`);}
    writeFileSync(join(directory,'domain.mjs'),source.replace(from,to));
    for(const file of ['domain.test.js','properties.test.js']){writeFileSync(join(directory,file.replace('.js','.mjs')),readFileSync(`test/field-sales/${file}`,'utf8').replace('../../public/field-sales/domain.js','./domain.mjs'));}
    const full=spawnSync(process.execPath,['--test',join(directory,'domain.test.mjs'),join(directory,'properties.test.mjs')],{encoding:'utf8'});
    const properties=spawnSync(process.execPath,['--test',join(directory,'properties.test.mjs')],{encoding:'utf8'});
    if(full.status!==1||properties.status!==1||!full.stdout.includes('not ok')||!properties.stdout.includes('not ok')){throw new Error(`Mutant survived or test infrastructure failed: ${name}\n${full.stdout}\n${full.stderr}\n${properties.stdout}`);}
    results.push({name,killedByFullSuite:true,killedByPropertiesAlone:true});
  }
  console.log(JSON.stringify({killed:results.length,total:mutants.length,results},null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
