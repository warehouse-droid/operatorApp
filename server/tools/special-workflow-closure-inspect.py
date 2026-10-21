"""Read the exact SPREQ-000007 closure failure; never writes to NetSuite."""
from pathlib import Path
import re
import subprocess

source = subprocess.check_output([
    'sudo', '-n', 'docker', 'exec', 'mbbs-operator-app-app-1',
    'cat', '/app/src/netsuite.js'
]).decode()
source = re.sub(r'((?:from\s+|import\s*\()\s*)([\'"])(\./[^\'"]+)\2',
                lambda m: m[1] + m[2] + 'file:///app/src/' + m[3][2:] + m[2], source)
source += r'''
const closureFs=await import('node:fs');
const closureDb=await import('file:///app/src/db.js');
const closurePriority=await import('file:///app/src/operator-netsuite-request-pool.js');
try {await closurePriority.withOperatorNetSuitePriority(async()=>{
 const results=[];
 for(const order of [{id:1017068,kind:'salesOrder',ref:'SOB121380'},
                    {id:1017168,kind:'purchaseOrder',ref:'POB03934'}]) {
  const rows=await suiteqlAll(`SELECT t.id,t.tranid,t.status,BUILTIN.DF(t.status) AS status_text,
   tl.id AS rest_line_id,tl.uniquekey,tl.item,tl.isclosed AS line_closed,
   tl.quantity AS base_quantity,tl.rate AS line_rate,tl.foreignamount AS foreign_amount,
   tl.units AS unit_id,tl.memo AS description,i.unitstype AS units_type_id,
   ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity,
   ABS(NVL(tl.quantitybilled,0)) AS billed_quantity
   FROM transaction t JOIN transactionline tl ON tl.transaction=t.id
   LEFT JOIN item i ON i.id=tl.item
   WHERE t.id=${order.id} AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL`);
  const metadata=await suiteqlAll(`SELECT tl.* FROM transactionline tl WHERE tl.transaction=${order.id} AND tl.item=2055 AND tl.mainline='F' AND tl.taxline='F'`);
  console.log(JSON.stringify({ref:order.ref,quantityFields:metadata.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>/unit|rate|quantity/.test(key))))}));
  let rest;
  try {
   const response=await netsuiteRest(`/record/v1/${order.kind}/${order.id}?expandSubResources=true`,{method:'GET'});
   rest={ok:true,record:response.data};
  }catch(error){rest={ok:false,status:error.status,codes:error.netsuiteErrorCodes,message:error.message};}
  const result={...order,rows,rest};results.push(result);
  console.log(JSON.stringify({...order,rows,rest:rest.ok?{ok:true,status:rest.record.status,
   lines:rest.record.item?.items?.map(l=>({line:l.line,itemId:l.item?.id,quantity:l.quantity,isClosed:l.isClosed}))}:rest}));
 }
 closureFs.writeFileSync('/tmp/special-closure-000007-inspect.private.json',JSON.stringify(results,null,2),{mode:0o600});
});}finally{await closureDb.closeDb();}process.exit(0);
'''
result = subprocess.run([
    'sudo', '-n', 'docker', 'exec', '-i', '-w', '/app',
    'mbbs-operator-app-app-1', 'node', '--input-type=module', '-'
], input=source.encode())
raise SystemExit(result.returncode)
