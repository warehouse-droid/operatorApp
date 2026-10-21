import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { readSpecialRestOrder } from './src/special-stock-rest-orders.js';

const temporary = `/tmp/special-so-122477-readonly-${process.pid}.mjs`;
const source = (await readFile('/app/src/netsuite.js', 'utf8')).replace(
  /((?:from\s+|import\s*\()\s*)(['"])(\.\.?\/[^'"]+)\2/g,
  (_, prefix, quote, relative) => `${prefix}${quote}${pathToFileURL(resolve('/app/src', relative)).href}${quote}`);
await writeFile(temporary, `${source}\nexport { netsuiteRest as diagnosticRest };\n`, { mode: 0o600, flag: 'wx' });
try {
  const ns = await import(pathToFileURL(temporary).href);
  const headers = await ns.suiteqlAll(`SELECT id,tranid,externalid,memo,entity AS entity_id,
    status,BUILTIN.DF(status) AS status_text,lastmodifieddate
    FROM transaction WHERE type='SalesOrd' AND tranid='SOB122477'`);
  assert.equal(headers.length, 1, 'Expected one NetSuite Sales Order');
  const header = headers[0];
  const marker = String(header.externalid || '').match(/^MBBS-SPECIAL-SO:(\d+)$/i)
    || String(header.memo || '').match(/MBBS-SPECIAL-SO:(\d+)\b/i);
  const caseId = marker ? Number(marker[1]) : null;
  const local = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const order = (await query("SELECT to_jsonb(o) AS data FROM sales_orders o WHERE tranid='SOB122477'")).rows;
    const pending = (await query(`SELECT to_jsonb(r) AS request,to_jsonb(c) AS special
      FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
      WHERE c.sales_order_operation_status IN ('creating','attention')
        OR c.sales_order_netsuite_id=$1 OR r.id=$2 ORDER BY r.id`, [Number(header.id), caseId])).rows;
    const detail = caseId ? await getSpecialStockCase(caseId, { audience: 'scm', dispatchPlans: [] }) : null;
    const events = caseId ? (await query('SELECT * FROM sales_special_stock_events WHERE request_id=$1 ORDER BY id', [caseId])).rows : [];
    return { order, pending, detail, events };
  });
  const remoteRaw = (await ns.diagnosticRest(`/record/v1/salesOrder/${Number(header.id)}?expandSubResources=true`)).data;
  const remoteRows = await ns.suiteqlAll(`SELECT tl.uniquekey,tl.id AS rest_line_id,tl.item,t.status,
    ABS(NVL(tl.quantityshiprecv,0)) AS execution_quantity, ABS(NVL(tl.quantitybilled,0)) AS billed_quantity,
    tl.isclosed AS line_closed,tl.ratepercent,tl.location AS location_id
    FROM transactionline tl JOIN transaction t ON t.id=tl.transaction
    WHERE tl.transaction=${Number(header.id)} AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL`);
  let accountingRows = null;
  let accountingError = null;
  try {
    accountingRows = await ns.suiteqlAll(`SELECT tl.id,tl.uniquekey,tl.item,tl.transactiondiscount,tl.linesequencenumber,tl.netamount
      FROM transactionline tl WHERE tl.transaction=${Number(header.id)} AND tl.mainline='F' AND tl.taxline='F' AND tl.item IS NOT NULL`);
  } catch(error) { accountingError = {message:error.message}; }
  let remote = null;
  let remoteReadError = null;
  try {
    remote = await readSpecialRestOrder({ id: Number(header.id), kind: 'sales_order' },
      { rest: ns.diagnosticRest, queryAll: ns.suiteqlAll });
  } catch (error) { remoteReadError = { message: error.message, code: error.code || null }; }
  let markerMatches = [];
  let markerLookupError = null;
  try {
    markerMatches = caseId ? await ns.findSpecialStockOrdersByMarkerFromNetSuite({ caseId, orderKind: 'sales_order', entityId: header.entity_id }) : [];
  } catch (error) { markerLookupError = { message: error.message, code: error.code || null }; }
  console.log(JSON.stringify({ kind: 'special-so-122477-audit', at: new Date().toISOString(), header, caseId, local, remote, remoteRaw,remoteRows,remoteReadError, accountingRows,accountingError,markerMatches, markerLookupError,
    applicationWrites: 0, netSuiteWrites: 0, summary: { salesOrderRef: header.tranid, salesOrderId: Number(header.id),
      caseId, requestRef: local.detail?.requestRef || null, linkedSalesOrderId: local.detail?.salesOrderId || null,
      operationStatus: local.detail?.salesOrderOperationStatus || null, operationError: local.detail?.salesOrderOperationError || null,
      markerMatches: markerMatches.length, markerLookupError, remoteReadError, remoteRestLineCount: remoteRaw?.item?.items?.length ?? null,
      remoteQueryLineCount:remoteRows.length,attention: local.detail?.attention || false,
      accountingRows:accountingRows?.filter(row=>row.transactiondiscount==='T') || null,accountingError,
      pendingCases: local.pending.map(row => ({ id: row.request.id, requestRef: row.request.request_ref,
        operationStatus: row.special.sales_order_operation_status, error: row.special.sales_order_operation_error })) } }));
} finally {
  await rm(temporary, { force: true });
  await closeDb();
}
