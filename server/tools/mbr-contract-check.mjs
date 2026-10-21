import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const mode = process.argv[2] || 'all';
for (const root of ['/app/node_modules','/deps/node_modules']) {
  console.log('Tooling',root,Object.fromEntries(['playwright','fast-check','typescript','eslint','c8','pdfkit'].map(name=> {
    const filename=`${root}/${name}/package.json`;
    return [name,existsSync(filename)?JSON.parse(readFileSync(filename,'utf8')).version:'absent'];
  })));
}
const run = (command, args) => {
  const result = spawnSync(command, args, {stdio:'inherit',env:process.env});
  if (result.status !== 0) {process.exit(result.status || 1);}
};
const failureNames=output=>[...new Set(output.split('\n').filter(line=>line.startsWith('✖ ') && !line.startsWith('✖ failing tests:'))
  .map(line=>line.replace(/ \([\d.]+m?s\)$/u,'').trim()))];
function regressions() {
  const result=spawnSync('node',['tools/mbr-contract-regressions.mjs','focused'],{encoding:'utf8',maxBuffer:16*1024*1024,env:process.env});
  const output=(result.stdout || '')+(result.stderr || '');process.stdout.write(output);
  const baseline=JSON.parse(readFileSync('test/mbr/regression-baseline.json','utf8')).failureNames;
  const current=failureNames(output),newFailures=current.filter(name=>!baseline.includes(name));
  const count=label=>[...output.matchAll(new RegExp(`^ℹ ${label} (\\d+)$`,'gmu'))].reduce((sum,match)=>sum+Number(match[1]),0);
  const summary={exit:result.status,passed:count('pass'),failed:count('fail'),baselineFailures:baseline,currentFailures:current,newFailures};
  writeFileSync('test-artifacts/mbr-contract/regression-comparison.json',JSON.stringify(summary,null,2));
  console.log('Regression comparison:',JSON.stringify(summary));
  if(result.signal || result.status===null || newFailures.length || (result.status!==0 && current.length===0)) {process.exit(1);}
}
if (['static','all'].includes(mode)) {
  run('node',['node_modules/typescript/bin/tsc','--project','test/mbr/tsconfig.json','--noEmit']);
  run('node',['node_modules/eslint/bin/eslint.js','--config','test/mbr/eslint.config.mjs','--max-warnings=0',
    'src/mbr','public/mbr','test/mbr','tools/mbr-contract-*.mjs']);
}
// Legacy migration rehearsals must start from the pristine migrated database,
// before MBR acceptance fixtures add accounts with the new authority.
if (['regression','all'].includes(mode)) {regressions();}
if (mode === 'baseline') {
  run('npm', ['run','test:mbt']);
  run('node', ['--test','--test-concurrency=1','test/field-sales/*.test.js']);
}
if (['red','unit','all'].includes(mode)) {
  run('node', ['--test', '--test-concurrency=1', 'test/mbr/domain.test.js']);
}
if (['unit','all'].includes(mode)) {
  run('node', ['--test', '--test-concurrency=1', 'test/mbr/properties.test.js','test/mbr/security.test.js']);
}
if (['integration','all'].includes(mode)) {
  run('node', ['--test', '--test-concurrency=1', 'test/mbr/repository.test.js']);
  run('node', ['--test', '--test-concurrency=1', 'test/mbr/http.test.js']);
  run('node', ['--test', '--test-concurrency=1', 'test/mbr/runtime.test.js']);
}
if (mode==='regression-baseline') {
  run('node',['tools/mbr-contract-regressions.mjs','focused']);
}
if (['coverage','all'].includes(mode)) {
  if (mode==='all') {
    const order=['domain','properties','security','repository','http','runtime'];
    let seed=131026;
    for(let index=order.length-1;index>0;index-=1) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const position=seed%(index+1);[order[index],order[position]]=[order[position],order[index]];
    }
    console.log('Suite health seed 131026:',order.join(', '));
    for(const name of order) {run('node',['--test','--test-concurrency=1',`test/mbr/${name}.test.js`]);}
  }
  run('node',['node_modules/c8/bin/c8.js','--config=test/mbr/c8.json','node','--test','--test-concurrency=1',
    'test/mbr/domain.test.js','test/mbr/properties.test.js','test/mbr/security.test.js','test/mbr/repository.test.js','test/mbr/http.test.js','test/mbr/runtime.test.js']);
}
if (['mutation','all'].includes(mode)) {run('node',['tools/mbr-contract-mutations.mjs']);}
if (mode==='inspect') {run('node',['tools/mbr-contract-pdf-inspect.mjs']);}
if (['browser','all'].includes(mode)) {
  run('node', ['test/mbr/browser.mjs']);
}
