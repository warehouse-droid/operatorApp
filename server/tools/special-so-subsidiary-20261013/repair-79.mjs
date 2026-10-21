import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { writeAudit } from './src/auth-repository.js';
import { suiteqlAll, findSpecialStockOrdersWithNativeLinkFromNetSuite } from './src/netsuite.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { createSpecialStockRequestService } from './src/special-stock-request-service.js';

const requestId = 198, correctCustomerId = 6826;
const context = { authorizedStoreLocationIds: [1] };
const snapshotLines = async () => (await query(`SELECT
  (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) FROM sales_special_stock_lines line WHERE request_id=$1) AS materials,
  (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) FROM sales_special_stock_order_lines line WHERE request_id=$1) AS orders`, [requestId])).rows[0];

try {
  let detail = await getSpecialStockCase(requestId, { audience: 'scm' });
  assert.equal(detail.requestRef, 'SPREQ-000079');
  if (!detail.salesOrderId) {
    const customer = await suiteqlAll("SELECT id,entityid,companyname,subsidiary,isinactive FROM customer WHERE id=6826");
    assert.equal(customer.length, 1);
    assert.equal(Number(customer[0].id), correctCustomerId);
    assert.match(customer[0].entityid, /^802236\b/);
    assert.equal(Number(customer[0].subsidiary), 1);
    assert.equal(customer[0].isinactive, 'F');
    const markers = await findSpecialStockOrdersWithNativeLinkFromNetSuite({ caseId: requestId, orderKind: 'sales_order' });
    assert.equal(markers.length, 0, 'An existing remote marker must be recovered before changing the customer');
    const deadline = Date.now() + 60_000;
    detail = await getSpecialStockCase(requestId, { audience: 'scm' });
    while (detail.salesOrderOperationStatus === 'creating' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      detail = await getSpecialStockCase(requestId, { audience: 'scm' });
    }
    assert.equal(detail.salesOrderOperationStatus, 'idle', 'The existing creation attempt must finish first');
    await withTransaction(async () => {
      const { rows: [saved] } = await query(`SELECT request.revision,special.* FROM sales_stock_requests request
        JOIN sales_special_stock_cases special ON special.request_id=request.id WHERE request.id=$1
        FOR UPDATE OF request,special`, [requestId]);
      assert.equal(Number(saved.revision), detail.revision);
      assert.equal(saved.sales_order_netsuite_id, null);
      assert.equal(saved.purchase_order_netsuite_id, null);
      assert.equal(saved.sales_order_operation_status, 'idle');
      assert.equal(saved.sales_order_submission_started_at, null);
      assert.ok([13430, correctCustomerId].includes(Number(saved.order_customer_netsuite_id)));
      const directory = (await query('SELECT * FROM return_customer_directory WHERE netsuite_customer_id=$1 FOR SHARE', [correctCustomerId])).rows[0];
      assert.match(directory.entity_code, /^802236\b/);
      const before = await snapshotLines();
      if (Number(saved.order_customer_netsuite_id) !== correctCustomerId) {
        const correction = { source: 'codex', requestedCustomerNumber: '802236',
          previousCustomerId: Number(saved.order_customer_netsuite_id), customerId: correctCustomerId,
          subsidiaryId: 1, customerName: customer[0].companyname,
          reason: 'User requested the Mr Bin Building Supply LTD account and authorized SO creation retry.' };
        await query(`UPDATE sales_special_stock_cases SET canonical_customer_id=NULL,directory_customer_id=$2,
          customer_name=$3,order_customer_netsuite_id=$2,order_customer_name=$3,updated_at=now() WHERE request_id=$1`,
        [requestId, correctCustomerId, customer[0].companyname]);
        await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1', [requestId]);
        await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
          VALUES($1,'special_customer_account_corrected',NULL,'sales_scm',$2::jsonb)`, [requestId, JSON.stringify(correction)]);
        await writeAudit({ actorType: 'system', source: 'codex', action: 'special.customer_account.corrected',
          details: { requestId, requestRef: detail.requestRef, ...correction } });
      }
      assert.deepEqual(await snapshotLines(), before, 'Customer correction must preserve every material and order draft row');
    });
    detail = await getSpecialStockCase(requestId, { audience: 'scm' });
    assert.equal(detail.netsuiteCustomerId, correctCustomerId);
    console.log(JSON.stringify({ customerCorrected: true, requestRef: detail.requestRef,
      customerNumber: '802236', internalCustomerId: correctCustomerId, subsidiaryId: 1, revision: detail.revision }));
    const service = createSpecialStockRequestService();
    detail = await service.createSalesOrder(requestId, { expectedRevision: detail.revision,
      operationId: crypto.randomUUID(), source: 'standalone', salesRepId: detail.netsuiteSalesRepId }, context);
  }
  assert.ok(detail.salesOrderId);
  const remote = await suiteqlAll(`SELECT transaction.id,transaction.tranid,transaction.entity,line.subsidiary,transaction.externalid,transaction.status
    FROM transaction JOIN transactionline line ON line.transaction=transaction.id AND line.mainline='T'
    WHERE transaction.id=${Number(detail.salesOrderId)} AND transaction.type='SalesOrd'`);
  assert.equal(remote.length, 1);
  assert.equal(Number(remote[0].entity), correctCustomerId);
  assert.equal(Number(remote[0].subsidiary), 1);
  assert.equal(remote[0].tranid, detail.salesOrderRef);
  const matches = await findSpecialStockOrdersWithNativeLinkFromNetSuite({ caseId: requestId, orderKind: 'sales_order' });
  assert.equal(matches.length, 1);
  assert.equal(Number(matches[0].id), detail.salesOrderId);
  console.log(JSON.stringify({ success: true, requestRef: detail.requestRef, salesOrderId: detail.salesOrderId,
    salesOrderRef: detail.salesOrderRef, customerNumber: '802236', customerId: correctCustomerId,
    subsidiaryId: 1, markerMatches: matches.length, operationStatus: detail.salesOrderOperationStatus }));
} finally { await closeDb(); }
