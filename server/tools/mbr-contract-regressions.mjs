import {readdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const focused=[
  'test/mbt/integration/authority-roles.test.js',
  'test/mbt/integration/http-role-matrix.test.js',
  'test/mbt/integration/menu-order-http.test.js',
  'test/mbt/integration/staff-login-browser.test.js'
];
const fieldSales=(await readdir('test/field-sales')).filter(name=>name.endsWith('.test.js')).sort().map(name=>'test/field-sales/'+name);
if(process.argv[2]==='focused') {
  process.exitCode=await runNodeTestFilesIsolated([...focused,...fieldSales],{environment:process.env,label:'MBR shared regressions'});
} else {
  const result=spawnSync('npm',['run','test:mbt:unit'],{encoding:'utf8',maxBuffer:32*1024*1024});
  const output=(result.stdout || '')+(result.stderr || '');
  await writeFile('test-artifacts/mbr-contract/regression-unit.log',output);
  const old=await readFile('test-artifacts/mbr-contract/baseline-checks.log','utf8');
  const failures=text=>new Set(text.split('\n').filter(line=>line.startsWith('✖ ') && !line.startsWith('✖ failing tests:'))
    .map(line=>line.replace(/ \([\d.]+m?s\)$/u,'').trim()));
  const previous=failures(old),current=failures(output),newFailures=[...current].filter(name=>!previous.has(name));
  const summary={command:'npm run test:mbt:unit',exit:result.status,newFailures,currentFailures:[...current],
    baselineFailureCount:previous.size};
  await writeFile('test-artifacts/mbr-contract/regression-unit-comparison.json',JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
  if(result.signal || result.status===null || newFailures.length) {process.exitCode=1;}
}
