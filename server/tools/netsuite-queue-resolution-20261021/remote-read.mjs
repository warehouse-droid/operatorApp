// NetSuite SuiteQL/record reads and local SELECTs only; no posting adapters.
import assert from 'node:assert/strict';
import { query, closeDb } from './src/db.js';
import { suiteqlAll, fetchItemFulfillmentFromNetSuite, findOperatorNetSuitePostingTransactionByExternalId } from './src/netsuite.js';
import { listOperatorNetSuitePostingAttentionCommands } from './src/operator-netsuite-posting-repository.js';
import { listSalesOrderAutoFulfillmentCandidates } from './src/sales-order-auto-fulfillment-repository.js';
import { listTransferPostingJobs } from './src/transfer-order-posting-repository.js';
try {
  const native = await listOperatorNetSuitePostingAttentionCommands({limit:500});
  const sales = await listSalesOrderAutoFulfillmentCandidates({statuses:['waiting_evidence','attention','uncertain','failed','historical','gate_disabled'],limit:500});
  const transfers = await listTransferPostingJobs();
  const refs = [...new Set([...sales.map(c=>c.sourceSalesOrderRef || c.dispatchOrderRef.replace(/-S\d+$/i,'')),
    ...native.flatMap(c=>c.steps.map(s=>s.sourceOrderRef)), ...transfers.map(j=>j.order_ref)])];
  assert.ok(refs.every(ref=>/^[A-Za-z0-9_-]+$/.test(ref)));
  const requestedIds = [...new Set([...sales.map(c=>c.sourceSalesOrderId),...native.flatMap(c=>c.steps.map(s=>s.sourceNetSuiteId)),
    ...transfers.map(j=>j.local_to_id)].map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))];
  const headers = await suiteqlAll(`SELECT id,tranid,type,status,BUILTIN.DF(status) AS status_text,lastmodifieddate
    FROM transaction WHERE type IN ('SalesOrd','TrnfrOrd') AND (id IN (${requestedIds.join(',')}) OR tranid IN (${refs.map(r=>`'${r}'`).join(',')}))`);
  console.log(JSON.stringify({event:'headers',at:new Date().toISOString(),headers}));
  const ids = headers.map(h=>Number(h.id));assert.ok(ids.length && ids.every(id=>Number.isSafeInteger(id)&&id>0));
  const lines = await suiteqlAll(`SELECT tl.transaction AS source_id,tl.id AS order_line,tl.uniquekey AS source_line_key,
    tl.item AS item_id,i.itemtype AS item_type,i.isfulfillable AS is_fulfillable,BUILTIN.DF(tl.item) AS item_name,
    tl.quantity,tl.quantityshiprecv AS fulfilled_quantity,tl.isclosed AS is_closed,tl.donotprintline AS do_not_print_line,
    tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,uom.conversionrate AS conversion_rate,
    tl.location AS location_id,BUILTIN.DF(tl.location) AS location
    FROM transactionline tl LEFT JOIN item i ON i.id=tl.item LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
    WHERE tl.transaction IN (${ids.join(',')}) AND tl.item IS NOT NULL AND tl.mainline='F' AND (tl.taxline='F' OR tl.taxline IS NULL)
    ORDER BY tl.transaction,tl.id`);
  console.log(JSON.stringify({event:'source-lines',at:new Date().toISOString(),lines}));
  const linked = await suiteqlAll(`SELECT link.previousdoc AS source_id,link.previousline AS source_line,
    t.id,t.tranid,t.type,t.status,BUILTIN.DF(t.status) AS status_text,t.lastmodifieddate,
    tl.id AS transaction_line,tl.item AS item_id,tl.quantity,tl.units AS unit_id,BUILTIN.DF(tl.units) AS unit,
    uom.conversionrate AS conversion_rate,tl.location AS location_id
    FROM NextTransactionLineLink link JOIN transaction t ON t.id=link.nextdoc
    JOIN transactionline tl ON tl.transaction=link.nextdoc AND tl.id=link.nextline
    LEFT JOIN UnitsTypeUom uom ON uom.internalid=tl.units
    WHERE link.previousdoc IN (${ids.join(',')}) AND t.type IN ('ItemShip','ItemRcpt')
    AND tl.item IS NOT NULL AND (tl.taxline='F' OR tl.taxline IS NULL)
    ORDER BY link.previousdoc,t.id,tl.id`);
  console.log(JSON.stringify({event:'linked-transactions',at:new Date().toISOString(),linked}));
  const local = (await query(`SELECT o.netsuite_id,o.tranid,o.status,o.status_text,o.operator_status,o.local_yard_order_status,o.fulfillment_status,
    (SELECT jsonb_agg(jsonb_build_object('id',l.id,'lineId',l.line_id,'orderLine',l.netsuite_order_line,'itemId',l.item_id,'itemType',l.item_type,
      'quantity',l.quantity,'loaded',l.loaded_qty,'packed',l.packed_sales_qty,'unit',l.unit,'location',l.location_id,'active',l.netsuite_active))
      FROM sales_order_lines l WHERE l.sales_order_id=o.netsuite_id) AS lines,
    (SELECT jsonb_agg(jsonb_build_object('id',r.id,'createdAt',r.created_at,'lines',r.line_snapshot)) FROM operator_load_records r WHERE r.order_id=o.netsuite_id) AS loads
    FROM sales_orders o WHERE o.netsuite_id=ANY($1::bigint[]) OR lower(o.tranid)=ANY($2::text[])`,
    [ids,sales.map(c=>c.dispatchOrderRef.toLowerCase())])).rows;
  const jobs = (await query('SELECT * FROM transfer_order_posting_jobs WHERE id=ANY($1::uuid[])',[transfers.map(j=>j.id)])).rows;
  const events = (await query(`SELECT c.id,to_jsonb(e) AS event,(eff.id IS NOT NULL) AS effective FROM dispatch_sales_order_if_candidates c
    JOIN dispatch_order_completion_events e ON e.id=c.completion_event_id LEFT JOIN dispatch_effective_order_completion_events eff ON eff.id=e.id
    WHERE c.id=ANY($1::uuid[])`,[sales.map(c=>c.id)])).rows;
  console.log(JSON.stringify({event:'local-evidence',at:new Date().toISOString(),local,jobs,events}));
  const recoveries=[...native.flatMap(c=>c.steps.map(s=>({queue:'native',id:c.id,step:s,ref:s.sourceOrderRef,
    remoteId:s.netSuiteTransactionId || s.response?.observedTransaction?.id}))),
    ...sales.filter(c=>c.status==='uncertain').map(c=>({queue:'sales',id:c.id,ref:c.dispatchOrderRef,
      remoteId:c.netSuiteTransactionId || c.result?.observedTransaction?.id,
      step:{sourceNetSuiteId:c.sourceSalesOrderId,sourceOrderKind:'SO',transactionType:'IF',externalId:c.externalId,payload:c.payload,lineSnapshot:c.lineSnapshot}}))];
  for(const input of recoveries){
    try{
      const found=input.remoteId?{id:input.remoteId}:await findOperatorNetSuitePostingTransactionByExternalId(input.step.externalId,'IF',input.step.sourceNetSuiteId,{direct:true});
      const record=found?.record || (found?.id?await fetchItemFulfillmentFromNetSuite(found.id):null);
      console.log(JSON.stringify({event:'existing-record',at:new Date().toISOString(),...input,record}));
    }catch(error){console.log(JSON.stringify({event:'existing-record',...input,error:{code:error.code,message:error.message}}));}
  }
} finally {await closeDb();}
