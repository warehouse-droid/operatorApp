// Run from the server root. Default is read-only; --apply is the explicitly
// authorized recovery of SPREQ-000007's exact observed HTTP 400 rejection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { query, withTransaction, closeDb } = await import(`${process.cwd()}/src/db.js`);
const { getSpecialStockCase } = await import(`${process.cwd()}/src/special-stock-request-repository.js`);
const { createSpecialStockRequestService } = await import(`${process.cwd()}/src/special-stock-request-service.js`);
const { findSpecialStockOrdersByMarkerFromNetSuite, resolveSpecialOrderUnitsFromNetSuite,
  fetchSalesOrderReturnLinesFromNetSuite, suiteqlAll } = await import(`${process.cwd()}/src/netsuite.js`);
const { buildSpecialSalesOrderPayload } = await import(`${process.cwd()}/src/special-stock-request-netsuite.js`);

const approved = { id: 62, requestRef: 'SPREQ-000007', revision: 11,
  operationId: '0546a3b5-d2b8-4054-bb7c-731eac7008bf', started: '2026-09-26T02:37:57.113Z' };
const expectedLines = [[2055, 'PC', 500, 17, 'Unilock Ltd Endura Coping Lineo Buff'], [1784, 'EACH', 11, 40, 'PALLET']];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function protectedFingerprint() {
  return withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const rows = (await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000006' AND request_type='special'")).rows;
    assert.equal(rows.length, 1);
    return digest(await getSpecialStockCase(rows[0].id, { audience: 'scm' }));
  });
}
function validate(detail) {
  assert.equal(detail.id, approved.id);
  assert.equal(detail.requestRef, approved.requestRef);
  assert.equal(detail.revision, approved.revision);
  assert.equal(detail.salesOrderId, null);
  assert.equal(detail.purchaseOrderId, null);
  assert.equal(detail.salesOrderOperationStatus, 'attention');
  assert.equal(detail.salesOrderOperationId, approved.operationId);
  assert.equal(new Date(detail.salesOrderSubmissionStartedAt).toISOString(), approved.started);
  assert.equal(detail.customerId, 8444);
  assert.equal(detail.operationalYardLocationId, 1);
  assert.deepEqual(detail.salesOrderLines.map(l => [l.itemId, l.uom, l.quantity, l.rate, l.description]), expectedLines);
  const match = /^NetSuite REST failed: 400 (\{.*\}) The marker is not visible, so no automatic resubmission was attempted\.$/s.exec(detail.salesOrderOperationError);
  assert.ok(match, 'Only the observed definitive location rejection can be rearmed');
  const response = JSON.parse(match[1]);
  assert.equal(response.status, 400);
  assert.equal(response['o:errorDetails'].length, 1);
  assert.equal(response['o:errorDetails'][0]['o:errorCode'], 'USER_ERROR');
  assert.equal(response['o:errorDetails'][0]['o:errorPath'], 'item.items[1]');
  assert.equal(response['o:errorDetails'][0].detail, 'Error while accessing a resource. Please enter value(s) for: Location.');
}
const mode = process.argv.at(-1);
try {
  const untouched = await protectedFingerprint();
  const before = await getSpecialStockCase(approved.id, { audience: 'scm' });
  if (mode === '--snapshot') {
    validate(before);
    console.log(JSON.stringify({ at: new Date().toISOString(), protectedFingerprint: untouched, detail: before }));
  } else {
    validate(before);
    const matches = await findSpecialStockOrdersByMarkerFromNetSuite({ caseId: approved.id, orderKind: 'sales_order' });
    assert.deepEqual(matches, [], 'An existing marker must be recovered through the app, never rearmed');
    const resolved = await resolveSpecialOrderUnitsFromNetSuite(before.salesOrderLines);
    assert.deepEqual(resolved.map(l => l.unitId), [865, 246]);
    const payload = buildSpecialSalesOrderPayload({ caseId: approved.id, netsuiteLocationId: 1, deliveryMethodId: 2,
      draft: { ...before, materialLines: resolved, ancillaryLines: [] } });
    assert.deepEqual(payload.item.items.map(l => l.units), ['865', '246']);
    assert.deepEqual(payload.item.items.map(l => l.location), [{ id: '1' }, { id: '1' }]);
    if (mode === '--apply') {
      await withTransaction(async () => {
        await query("SET LOCAL lock_timeout='5s'");
        const locked = await query(`SELECT r.id,s.sales_order_submission_started_at::text AS submission_started_at_exact
          FROM sales_stock_requests r JOIN sales_special_stock_cases s ON s.request_id=r.id
          WHERE r.id=$1 AND r.request_ref=$2 AND r.revision=$3 FOR UPDATE OF r,s`, [approved.id, approved.requestRef, approved.revision]);
        assert.equal(locked.rowCount, 1, 'The authorized case revision changed');
        const current = await getSpecialStockCase(approved.id, { audience: 'scm' });
        validate(current);
        assert.equal(digest(current), digest(before), 'The saved case changed during preflight');
        const result = await query(`UPDATE sales_special_stock_cases SET sales_order_submission_started_at=NULL,updated_at=now()
          WHERE request_id=$1 AND sales_order_operation_id=$2 AND sales_order_operation_status='attention'
          AND sales_order_netsuite_id IS NULL AND sales_order_submission_started_at=$3`,
        [approved.id, approved.operationId, locked.rows[0].submission_started_at_exact]);
        assert.equal(result.rowCount, 1);
        await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1', [approved.id]);
        await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
          VALUES($1,'special_sales_order_units_retry_authorized',NULL,'all',$2::jsonb)`, [approved.id, JSON.stringify({
          operationId: approved.operationId, previousSubmissionStartedAt: approved.started,
          reason: 'User authorized retry only SPREQ-000007; corrected scalar REST units and required line locations; fresh marker search returned no order.',
          previousError: before.salesOrderOperationError, protectedRequest: 'SPREQ-000006', draftHash: digest(before.salesOrderLines)
        })]);
      });
      const detail = await createSpecialStockRequestService().createSalesOrder(approved.id,
        { expectedRevision: approved.revision + 1, operationId: approved.operationId, source: 'standalone' });
      assert.ok(detail.salesOrderId);
      assert.equal(detail.purchaseOrderId, null);
      let readback;
      try {
        const rows = await fetchSalesOrderReturnLinesFromNetSuite(detail.salesOrderId);
        readback = rows.map(l => [Number(l.item.id), String(l.units), Number(l.quantity), Number(l.rate), l.description]);
      } catch (error) {
        // NetSuite may immediately lock Pending Approval records even for GET.
        // Querying transaction lines remains read-only and includes base/native
        // quantity evidence; both requested units have conversion rate one.
        if (!error.message.includes('locked by a user defined workflow')) throw error;
        const rows = await suiteqlAll(`SELECT tl.item,tl.units,ABS(tl.quantity) AS quantity,tl.rate,tl.memo AS description
          FROM transactionline tl WHERE tl.transaction=${Number(detail.salesOrderId)} AND tl.mainline='F' AND tl.taxline='F'
          AND tl.item IS NOT NULL ORDER BY tl.id`);
        readback = rows.map(l => [Number(l.item), String(l.units), Number(l.quantity), Number(l.rate), l.description]);
      }
      assert.deepEqual(readback, [[2055, '865', 500, 17, expectedLines[0][4]], [1784, '246', 11, 40, 'PALLET']]);
      const markers = await findSpecialStockOrdersByMarkerFromNetSuite({ caseId: approved.id, orderKind: 'sales_order' });
      assert.equal(markers.length, 1);
      assert.equal(Number(markers[0].id), detail.salesOrderId);
      assert.equal(await protectedFingerprint(), untouched, 'SPREQ-000006 changed during recovery; inspect separately without retrying it');
      console.log(JSON.stringify({ recovered: true, requestRef: detail.requestRef, salesOrderId: detail.salesOrderId,
        salesOrderRef: detail.salesOrderRef, status: detail.salesOrderStatus, attention: detail.attention,
        lines: readback, exactMarkerCount: markers.length, protectedRequestUnchanged: true }));
    } else {
      assert.ok(mode !== '--snapshot');
      console.log(JSON.stringify({ readOnly: true, requestRef: before.requestRef, revision: before.revision,
        noExistingMarker: true, resolvedUnits: resolved.map(l => l.unitId), correctedUnits: payload.item.items.map(l => l.units),
        protectedFingerprint: untouched, caseHash: digest(before) }));
    }
  }
} finally { await closeDb(); }
