import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {query,withTransaction,closeDb} from './src/db.js';
import {getSpecialStockCase} from './src/special-stock-request-repository.js';
import {buildSpecialPurchaseOrderPayload} from './src/special-stock-request-netsuite.js';
import {readSpecialRestOrder} from './src/special-stock-rest-orders.js';
import {findLinkedSpecialPurchaseOrder} from './src/special-stock-native-po-adapter.js';
import {withOperatorNetSuitePriority} from './src/operator-netsuite-request-pool.js';

const temporary=`/tmp/special-po-000041-inspect-${process.pid}.mjs`;
const source=readFileSync('/app/src/netsuite.js','utf8').replace(
  /((?:from\s+|import\s*\()\s*)(['"])(\.\.?\/[^'"]+)\2/g,
  (_,prefix,quote,relative)=>`${prefix}${quote}${pathToFileURL(resolve('/app/src',relative)).href}${quote}`);
writeFileSync(temporary,`${source}\nexport {netsuiteRest as diagnosticRest};\n`,{mode:0o600});
try{
  const ns=await import(pathToFileURL(temporary).href);
  const detail=await withTransaction(async()=>{await query('SET TRANSACTION READ ONLY');return getSpecialStockCase(125,{audience:'scm',dispatchPlans:[]});});
  assert.equal(detail.requestRef,'SPREQ-000041');
  await withOperatorNetSuitePriority(async()=>{
    const boundary={rest:(path,options={})=>{assert.equal(options.method||'GET','GET');return ns.diagnosticRest(path,options);},queryAll:ns.suiteqlAll};
    const sales=await readSpecialRestOrder({id:1042205,kind:'sales_order'},boundary);
    const purchase=await readSpecialRestOrder({id:1042761,kind:'purchase_order'},boundary);
    const payload=buildSpecialPurchaseOrderPayload({caseId:125,vendorId:detail.vendorId,salesOrderRef:detail.salesOrderRef,
      netsuiteLocationId:1,lines:await ns.resolveSpecialOrderUnitsFromNetSuite(detail.purchaseOrderLines),vendorDiscountReview:detail.vendorDiscountReview});
    let recovery;
    try{recovery={passed:true,result:await findLinkedSpecialPurchaseOrder({salesOrderId:detail.salesOrderId,
      salesOrderLines:detail.salesOrderLines,purchaseOrderLines:detail.purchaseOrderLines,payload},boundary)};}
    catch(error){recovery={passed:false,code:error.code,message:error.message};}
    console.log(JSON.stringify({at:new Date().toISOString(),requestRef:detail.requestRef,revision:detail.revision,
      sales:{id:1042205,ref:sales.record.tranId,snapshot:sales.snapshot},
      purchase:{id:1042761,ref:purchase.record.tranId,createdFrom:purchase.record.createdFrom?.id,snapshot:purchase.snapshot},
      expected:payload.item.items,initialRecovery:recovery,applicationWrites:0,netSuiteWrites:0}));
  });
}finally{unlinkSync(temporary);await closeDb();}
