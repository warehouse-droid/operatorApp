import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as espree from 'espree';
import {scanUnifiedDiff,scanPaths} from '../test/support/scan-diff-secrets.mjs';
const out='test-artifacts/regular-waitlist',files=JSON.parse(readFileSync('tools/regular-waitlist-files.json')),diffs=JSON.parse(readFileSync(out+'/changed-diffs.json'));
const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
for(const [file,data] of Object.entries(diffs.files))assert.equal(data.sourceHash,sourceHashes[file],'Changed-line source must match: '+file);
const added=files.filter(file=>!existsSync(out+'/before/'+file));
const tooling=readdirSync('tools').filter(file=>file.startsWith('regular-waitlist')).map(file=>'tools/'+file);
const tests=['test/regular-waitlist-spec.md','test/support/regular-waitlist-fixture.mjs',...['unit','property','integration','adversarial'].flatMap(group=>readdirSync('test/mbt/'+group).filter(file=>file.startsWith('regular-waitlist')).map(file=>'test/mbt/'+group+'/'+file))];
const findings=[...Object.values(diffs.files).flatMap(data=>scanUnifiedDiff(data.diff)),...await scanPaths([...added,...tooling,...tests])];
assert.deepEqual(findings,[],'Scoped source and tooling must contain no credentials');
const newModules=files.filter(file=>file.endsWith('.js')&&file.includes('waitlist'));
const allNew=newModules.map(file=>readFileSync(file,'utf8')).join('\n');
assert(!allNew.includes('dispatch_so_po_allocations'),'Waitlist cannot use Dispatch quantity allocations');
assert(!/updateSalesOrder|patchSalesOrder|updatePurchaseOrder|patchPurchaseOrder/u.test(allNew),'Waitlist cannot edit existing NetSuite SOs or POs');
const functions=[];
function visit(node,file){
  if(!node||typeof node!=='object')return;
  if(/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(node.type))functions.push({file,name:node.id?.name||'(callback)',lines:node.loc.end.line-node.loc.start.line+1});
  for(const value of Object.values(node)){if(Array.isArray(value))for(const child of value)visit(child,file);else if(value?.type)visit(value,file);}
}
for(const file of newModules)visit(espree.parse(readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'module',loc:true}),file);
assert(functions.every(fn=>fn.lines<=80),'New functions stay within the 80-line budget');
const result={sourceHashes,sourceTreeSha256:createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),secretFindings:findings,newDependencies:0,
  capabilities:{localLedger:true,remoteRead:'Verified yard/item units and exact conversion marker',remoteWrite:'Create one new Sales Order per conversion',dispatchQuantityAllocationAccess:false,existingSalesOrderUpdates:false,purchaseOrderUpdates:false},
  complexity:{functionCount:functions.length,largestFunction:Math.max(...functions.map(fn=>fn.lines)),budget:80}};
writeFileSync(out+'/safety.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,sourceHashes:undefined}));
