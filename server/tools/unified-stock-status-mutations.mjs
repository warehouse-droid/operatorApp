import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const out='test-artifacts/unified-stock-status',source=readFileSync('public/regular-stock-status.js','utf8');
const mutants=[
  ['sales-before-scm',"const priority = ['pending_scm','pending_sales'","const priority = ['pending_sales','pending_scm'"],
  ['require-every-line-success',"const completed = states.some(s => s.status === 'completed');","const completed = states.every(s => s.status === 'completed');"],
  ['drop-transfer-badge',"line.supplyStatus === reason && !terminalStatuses","reason !== 'vendor_transfer' && line.supplyStatus === reason && !terminalStatuses"],
  ['ignore-supply-filter',"&& (!filters.waitingReason || summary.waitingReasons.includes(filters.waitingReason))","&& true"],
  ['closed-is-active',"!['completed','closed'].includes(summary.status)","!['completed'].includes(summary.status)"]
];
const suites={examples:'test/mbt/unit/regular-stock-status.test.js',properties:'test/mbt/property/regular-stock-status.property.test.js'},report=[];
const root=mkdtempSync('/tmp/unified-status-mutants-');
try{
  for(const file of ['public/regular-stock-status.js','public/special-stock-workflow.js',...Object.values(suites)]){
    mkdirSync(`${root}/${file.slice(0,file.lastIndexOf('/'))}`,{recursive:true});cpSync(file,`${root}/${file}`);
  }
  symlinkSync('/app/node_modules',root+'/node_modules');writeFileSync(root+'/package.json','{"type":"module"}');
  for(const [name,needle,replacement] of mutants){
    assert.equal(source.split(needle).length,2,`${name}: mutation must match once`);
    writeFileSync(`${root}/public/regular-stock-status.js`,source.replace(needle,replacement));
    for(const [suite,file] of Object.entries(suites)){
      const result=spawnSync(process.execPath,['--test',file],{cwd:root,encoding:'utf8',timeout:30000});
      const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/mutant-${name}-${suite}.log`,log);
      const killed=result.status===1&&/not ok \d+/.test(log)&&!/ERR_MODULE_NOT_FOUND|SyntaxError/.test(log);
      report.push({name,suite,killed});assert(killed,`${name} survived ${suite}`);
    }
  }
}finally{rmSync(root,{recursive:true,force:true});writeFileSync(`${out}/mutations.json`,JSON.stringify(report,null,2));}
assert.equal(readFileSync('public/regular-stock-status.js','utf8'),source);
console.log(JSON.stringify({mutants:mutants.length,exampleKills:report.filter(r=>r.suite==='examples'&&r.killed).length,propertyKills:report.filter(r=>r.suite==='properties'&&r.killed).length}));
