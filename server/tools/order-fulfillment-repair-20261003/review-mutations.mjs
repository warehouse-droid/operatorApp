import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const mutations=[
 ['reject_matched','adapter','if (!expectedByLine.has(orderLine)) {assertConfirmedNonInventoryLine(step, orderLine, actual);}',"if (!expectedByLine.has(orderLine)) {throw mismatch('Incorrect review');}"],
 ['ignore_uom','adapter','units !== line.salesUom','false'],
 ['ignore_quantity','adapter','Math.abs(Number(actual.quantity) - Number(expected.quantity)) > 0.000001','false'],
 ['unconfirmed','targets',"line.confirmed === true && line.netsuite_active !== false",'line.netsuite_active !== false'],
 ['lost_snapshot','domain','group.lineSnapshot.push(normalizedSelectedLine(rawLine));','void rawLine;']
];
const results=[];
for(const [name,module,oldText,replacement] of mutations){
 const source=fs.readFileSync(`src/operator-netsuite-posting-${module}.js`,'utf8');assert(source.includes(oldText));
 const path='/tmp/review-mutant-'+name+'.mjs';fs.writeFileSync(path,source.replace(oldText,replacement).replace(/(['"])\.\//g,'$1file:///app/src/'));
 for(const propertyOnly of [false,true]){
  const r=spawnSync(process.execPath,['--test',...(propertyOnly?['--test-name-pattern=non-inventory sales quantities']:[]),'tools/incident/review-rule.test.mjs'],{encoding:'utf8',env:{...process.env,['REVIEW_'+module.toUpperCase()+'_SOURCE']:path}});
  fs.writeFileSync(`test-artifacts/${name}-${propertyOnly?'property':'all'}.log`,r.stdout+r.stderr);
  assert.equal(r.status,1,name+' survived');assert.match(r.stdout,/ERR_ASSERTION|ERR_TEST_FAILURE/);assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/);
  results.push({name,propertyOnly,killed:true});
 }
}
console.log(JSON.stringify({mutants:results}));
