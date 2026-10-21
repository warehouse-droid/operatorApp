import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { refreshSpecialOrderStatusCache } from './src/special-stock-status-refresh.js';
import { specialPlanningStatus } from './public/special-stock-case-status.js';

async function fingerprint() {
  const result = await query(`SELECT jsonb_build_object(
    'request',(SELECT to_jsonb(r) FROM sales_stock_requests r WHERE id=95),
    'case',(SELECT to_jsonb(s) FROM sales_special_stock_cases s WHERE request_id=95),
    'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_special_stock_lines l WHERE request_id=95),
    'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_special_stock_order_lines l WHERE request_id=95),
    'canonicalSalesLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_order_lines l WHERE sales_order_id=1033108),
    'canonicalPurchaseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM purchase_order_lines l WHERE purchase_order_id=995310),
    'sales',(SELECT to_jsonb(s)-'status'-'status_text'-'synced_at'-'status_updated_at' FROM sales_orders s WHERE netsuite_id=1033108),
    'purchase',(SELECT to_jsonb(p)-'status'-'status_text'-'synced_at'-'status_updated_at' FROM purchase_orders p WHERE netsuite_id=995310)
  )::text AS value`);
  return createHash('sha256').update(result.rows[0].value).digest('hex');
}
async function cachedHeaders() {
  return (await query(`SELECT jsonb_build_object(
    'SO',(SELECT jsonb_build_object('status',status,'text',status_text,'synced',synced_at::text,'changed',status_updated_at::text) FROM sales_orders WHERE netsuite_id=1033108),
    'PO',(SELECT jsonb_build_object('status',status,'text',status_text,'synced',synced_at::text,'changed',status_updated_at::text) FROM purchase_orders WHERE netsuite_id=995310)
  ) AS value`)).rows[0].value;
}
async function verify() {
  const before = await getSpecialStockCase(95,{audience:'sales'});
  assert.equal(before.requestRef,'SPREQ-000024'); assert.equal(before.salesOrderId,1033108); assert.equal(before.purchaseOrderId,995310);
  const hash = await fingerprint();
  const mode = process.env.SPECIAL_STATUS_REPAIR_MODE || 'verify';
  const refresh = mode === 'verify' ? {attempted:0,updated:0,failed:0} : await refreshSpecialOrderStatusCache([before],{force:true});
  assert.equal(refresh.failed,0);
  if(mode!=='verify'){assert.equal(refresh.attempted,2);assert.equal(refresh.updated,2);}
  const detail = await getSpecialStockCase(95,{audience:'sales'});
  assert.equal(detail.revision,before.revision); assert.equal(await fingerprint(),hash);
  assert.equal(detail.salesOrderPickedUpAt.toISOString(),'2026-10-05T11:01:47.688Z');
  assert.equal(detail.purchaseOrderPickedUpAt.toISOString(),'2026-10-02T20:52:07.060Z');
  assert.equal(detail.purchaseOrderDropoffAt.toISOString(),'2026-10-02T23:00:11.110Z');
  assert.equal(detail.operationallyCompletedAt.toISOString(),'2026-10-05T13:34:03.290Z');
  const html = specialPlanningStatus(detail,false,{audience:'sales',showOrderPreviews:true});
  assert.match(html,/SO delivery: Delivered/); assert.match(html,/PO receipt: Arrived at yard/);
  assert.match(html,/2026-10-05 09:34:03 EDT/); assert.match(html,/2026-10-02 19:00:11 EDT/);
  assert.doesNotMatch(html,/NetSuite:|Pending Bill|Est\. arrival/);
  const health = await fetch('http://127.0.0.1:3000/health'); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
  for (const url of ['/sales-special-stock-requests.js','/scm-special-stock-requests.js']) {
    const response=await fetch('http://127.0.0.1:3000'+url); assert.equal(response.status,200);
    assert.match(await response.text(),/special-stock-case-status\.js\?v=20261005-status-following-v1/);
  }
  return {requestRef:detail.requestRef,revision:detail.revision,refresh,businessFingerprint:hash,businessUnchanged:true,
    salesOrderStatus:detail.salesOrderStatus,purchaseOrderStatus:detail.purchaseOrderStatus,
    pickedUpByDriver:{SO:detail.salesOrderPickedUpAt,PO:detail.purchaseOrderPickedUpAt},
    arrivedAtYard:detail.purchaseOrderDropoffAt,delivered:detail.operationallyCompletedAt,
    salesDisplay:{SO:'Delivered · 2026-10-05 09:34:03 EDT',PO:'Arrived at yard · 2026-10-02 19:00:11 EDT'},
    netSuiteWrites:0,health:'healthy',versionedAssets:true};
}
try {
  const before = await fingerprint();
  const mode = process.env.SPECIAL_STATUS_REPAIR_MODE || 'verify';
  const headers = await cachedHeaders();
  const result = mode === 'preview' ? await withTransaction(verify,{rollback:true}) : await verify();
  assert.equal(await fingerprint(),before);
  if(mode==='preview')assert.deepEqual(await cachedHeaders(),headers);
  console.log(JSON.stringify({...result,mode,rollbackRehearsed:mode==='preview'}));
} finally {await closeDb();}
