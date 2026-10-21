import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {query,withTransaction,closeDb} from './src/db.js';
import {getSpecialStockCase,linkSpecialPurchaseOrder} from './src/special-stock-request-repository.js';
import {readSpecialRestOrder} from './src/special-stock-rest-orders.js';
import {createSpecialOrderDocumentService} from './src/special-stock-documents.js';
import {withOperatorNetSuitePriority} from './src/operator-netsuite-request-pool.js';

const approved = APPROVED_SNAPSHOT;
const mode=process.argv.at(-1);assert.ok(['preflight','apply'].includes(mode));
const temporary=`/tmp/special-po-000041-recovery-${process.pid}.mjs`;
const backupFile='/tmp/special-po-000041-before.json',pdfFile='/tmp/special-po-000041-preview.pdf';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source=readFileSync('/app/src/netsuite.js','utf8').replace(
  /((?:from\s+|import\s*\()\s*)(['"])(\.\.?\/[^'"]+)\2/g,
  (_,prefix,quote,relative)=>`${prefix}${quote}${pathToFileURL(resolve('/app/src',relative)).href}${quote}`);
writeFileSync(temporary,`${source}\nexport {netsuiteRest as diagnosticRest};\n`,{mode:0o600});
try{
  const ns=await import(pathToFileURL(temporary).href);
  await withOperatorNetSuitePriority(async()=>{
    const boundary={rest:(path,options={})=>{assert.equal(options.method||'GET','GET');return ns.diagnosticRest(path,options);},queryAll:ns.suiteqlAll};
    const sales=await readSpecialRestOrder({id:1042205,kind:'sales_order'},boundary);
    const purchase=await readSpecialRestOrder({id:1042761,kind:'purchase_order'},boundary);
    assert.equal(sales.record.tranId,'SOB122143');assert.equal(purchase.record.tranId,'POB03999');
    assert.equal(Number(purchase.record.createdFrom?.id),1042205);
    assert.equal(purchase.snapshot.header.entity,'331');assert.equal(purchase.snapshot.header.location,'1');
    assert.deepEqual(sales.snapshot,approved.sales.snapshot,'The verified SO changed');
    assert.deepEqual(purchase.snapshot,approved.purchase.snapshot,'The verified existing PO changed');
    let originalRows;
    const before=await withTransaction(async()=>{
      await query('SET TRANSACTION READ ONLY');
      const detail=await getSpecialStockCase(125,{audience:'scm',dispatchPlans:[]});
      assert.equal(detail.requestRef,'SPREQ-000041');assert.ok(detail.revision>=15);
      assert.equal(detail.salesOrderId,1042205);assert.equal(detail.purchaseOrderId,null);
      assert.equal(detail.vendorId,331);assert.equal(detail.operationalYardLocationId,1);
      assert.equal(detail.purchaseOrderOperationStatus,'attention');assert.equal(detail.purchaseOrderSubmissionStartedAt,null);
      assert.equal(detail.purchaseOrderOperationId,'548fe458-1a82-4d99-8755-ccfd233feeff');
      assert.equal(detail.purchaseOrderOperationError,'The corresponding reviewed SO line is ambiguous.');
      assert.equal(detail.closeStatus,'active');assert.equal(detail.operationallyComplete,false);
      assert.equal(detail.quantityReviewPending,false);
      assert.ok(!['applying','attention'].includes(detail.fulfillmentChange?.status));
      const owners=await query('SELECT request_id FROM sales_special_stock_cases WHERE purchase_order_netsuite_id=1042761');assert.equal(owners.rowCount,0);
      const application=(await query(`SELECT jsonb_build_object('request',to_jsonb(r),'case',to_jsonb(c),
        'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=125),
        'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=125),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM sales_special_stock_events e WHERE request_id=125)) AS state
        FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=125`)).rows[0].state;
      originalRows={caseLines:application.caseLines,orderLines:application.orderLines};
      writeFileSync(backupFile,JSON.stringify({at:new Date().toISOString(),application,sales,purchase}),{mode:0o600});
      return detail;
    });
    if(mode==='preflight'){
      console.log(JSON.stringify({ready:true,requestRef:before.requestRef,revision:before.revision,purchaseOrderRef:'POB03999',
        vendorId:331,yardId:1,recovery:'custom_manual_reference',netSuiteWrites:0,applicationWrites:0}));return;
    }
    const linked=await withTransaction(async()=>{
      await query("SET LOCAL lock_timeout='5s'");
      const lock=await query(`SELECT r.id,r.revision FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
        WHERE r.id=125 AND r.request_ref='SPREQ-000041' AND c.purchase_order_netsuite_id IS NULL
        AND c.purchase_order_operation_status='attention' AND c.purchase_order_operation_id=$1
        AND c.purchase_order_submission_started_at IS NULL FOR UPDATE OF r,c`,[before.purchaseOrderOperationId]);
      assert.equal(lock.rowCount,1,'The request changed');
      const current=await getSpecialStockCase(125,{audience:'scm',dispatchPlans:[]});
      assert.equal(current.revision,Number(lock.rows[0].revision));assert.ok(current.revision>=before.revision);
      const protectedKeys=['requestRef','vendorId','operationalYardLocationId','salesOrderId','salesOrderApproved','purchaseOrderId',
        'purchaseOrderOperationId','purchaseOrderOperationStatus','purchaseOrderOperationError','purchaseOrderSubmissionStartedAt',
        'closeStatus','operationallyComplete','quantityReviewPending','quantityReview','fulfillmentChange','lines','salesOrderLines','purchaseOrderLines'];
      const protectedState=detail=>Object.fromEntries(protectedKeys.map(key=>[key,detail[key]]));
      assert.deepEqual(protectedState(current),protectedState(before),'Protected request data changed during preflight');
      const lockedApplication=(await query(`SELECT jsonb_build_object('request',to_jsonb(r),'case',to_jsonb(c),
        'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=125),
        'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=125),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM sales_special_stock_events e WHERE request_id=125)) AS state
        FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=125`)).rows[0].state;
      originalRows={caseLines:lockedApplication.caseLines,orderLines:lockedApplication.orderLines};
      writeFileSync(backupFile,JSON.stringify({at:new Date().toISOString(),application:lockedApplication,sales,purchase}),{mode:0o600});
      await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
        VALUES(125,'special_purchase_order_existing_reference_recovery',NULL,'all',$1::jsonb)`,[JSON.stringify({
        purchaseOrderId:1042761,purchaseOrderRef:'POB03999',salesOrderId:1042205,salesOrderRef:'SOB122143',
        userInstruction:'Resolve SPREQ-000041 manual linkage to POB03999 without leaving a failed-operation block',
        nativeOrderHash:digest(purchase.snapshot),historicalDraftPreserved:true,netSuiteWrites:0,
        descriptions:'Existing NetSuite vendor formatting retained through custom manual linkage'
      })]);
      const result=await linkSpecialPurchaseOrder(125,{expectedRevision:current.revision,purchaseOrderRef:'POB03999',customLinkage:true});
      assert.equal(result.purchaseOrderId,1042761);assert.equal(result.purchaseOrderOperationStatus,'linked');
      assert.equal(result.purchaseOrderOperationError,'');assert.equal(result.attention,false);assert.equal(result.salesOrderId,1042205);
      assert.equal(result.purchaseOrderCustomLinkage,true);
      const rows=(await query(`SELECT jsonb_build_object(
        'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=125),
        'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=125)) AS state`)).rows[0].state;
      assert.deepEqual(rows,originalRows,'Historical materials and drafts changed');return result;
    });
    assert.deepEqual((await readSpecialRestOrder({id:1042205,kind:'sales_order'},boundary)).snapshot,sales.snapshot);
    assert.deepEqual((await readSpecialRestOrder({id:1042761,kind:'purchase_order'},boundary)).snapshot,purchase.snapshot);
    const document=await createSpecialOrderDocumentService().preview(125,'purchase_order',{audience:'scm'});
    assert.ok(document.buffer.subarray(0,5).toString()==='%PDF-');writeFileSync(pdfFile,document.buffer,{mode:0o600});
    console.log(JSON.stringify({recovered:true,requestRef:linked.requestRef,revision:linked.revision,salesOrderRef:linked.salesOrderRef,
      purchaseOrderId:linked.purchaseOrderId,purchaseOrderRef:linked.purchaseOrderRef,customLinkage:linked.purchaseOrderCustomLinkage,
      operationStatus:linked.purchaseOrderOperationStatus,operationError:linked.purchaseOrderOperationError,attention:linked.attention,
      netSuiteWrites:0,currentNetSuiteOrdersPreserved:true,historicalDraftsPreserved:true,
      preview:{bytes:document.buffer.length,filename:document.filename,
        sha256:createHash('sha256').update(document.buffer).digest('hex')}}));
  });
}finally{unlinkSync(temporary);await closeDb();}
