/* global query,netsuiteRest,suiteqlAll,prepareSpecialClosurePlanInNetSuite,applySpecialClosurePlanInNetSuite,resolveSpecialOrderUnitsFromNetSuite,fetchTransactionStatusFromNetSuite */
// Appended to the deployed transport. Only the recorded Sales closure of case 64 is allowed.
const soCloseAssert = (await import('node:assert/strict')).default;
const soCloseFs = await import('node:fs');
const soCloseDb = await import('file:///app/src/db.js');
const soCloseRepo = await import('file:///app/src/special-stock-request-repository.js');
const soCloseService = await import('file:///app/src/special-stock-closure-service.js');
const soClosePriority = await import('file:///app/src/operator-netsuite-request-pool.js');
const soClosePath = '/tmp/special-so-only-closure-000009.private.json';
const soCloseMode = process.argv.at(-1);
const soCloseWrites = [];
let soCloseCheckpoint;
async function soCloseProtected() {
  const rows = (await query(`SELECT r.request_ref,md5(jsonb_build_object('request',to_jsonb(r),'case',to_jsonb(c),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=r.id),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM sales_special_stock_order_lines o WHERE request_id=r.id))::text) AS hash
    FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
    WHERE r.request_ref IN ('SPREQ-000006','SPREQ-000007') ORDER BY r.id`)).rows;
  soCloseAssert.equal(rows.length, 2); return rows;
}
function soCloseIdentity(detail) {
  soCloseAssert.deepEqual([detail.id, detail.requestRef, detail.salesOrderId, detail.salesOrderRef, detail.purchaseOrderId], [64, 'SPREQ-000009', 1017268, 'SOB121381', null]);
  soCloseAssert.equal(detail.salesOrderSkipped, false); soCloseAssert.equal(detail.purchaseOrderSkipped, false);
  soCloseAssert.equal(detail.dispatchPlanning.anyPlanned, false); soCloseAssert.equal(detail.operationallyComplete, false);
  soCloseAssert.equal(detail.quantityReviewPending, false);
}
const soCloseBoundary = { queryAll: suiteqlAll, rest: async (path, options = {}) => {
  soCloseAssert.match(path, /^\/record\/v1\/salesOrder\/1017268(?:\?expandSubResources=true)?$/);
  if (options.method && options.method !== 'GET') {
    soCloseAssert.equal(soCloseMode, 'apply'); soCloseAssert.equal(options.method, 'PATCH');
    const allowed = soCloseCheckpoint.plan.orders[0].lines.filter(line => !line.closed).map(line => ({ line: line.line, isClosed: true }));
    soCloseAssert.deepEqual(options.body, { item: { items: allowed } });
    soCloseWrites.push({ path, method: options.method, body: options.body });
  }
  return netsuiteRest(path, options);
} };
async function soClosePlan(detail) {
  return prepareSpecialClosurePlanInNetSuite({ orders: [{ kind: 'sales_order', id: 1017268,
    lines: await resolveSpecialOrderUnitsFromNetSuite(detail.salesOrderLines), discountCount: detail.salesOrderLines.filter(line => line.nativeDiscountPercent > 0).length }] }, soCloseBoundary);
}
async function soCloseVerify() {
  const detail = await soCloseRepo.getSpecialStockCase(64, { audience: 'scm' }); soCloseIdentity(detail);
  soCloseAssert.equal(detail.closeStatus, 'closed'); soCloseAssert.equal(detail.status, 'cancelled');
  soCloseAssert.equal(detail.closureReview.status, 'approved');
  const remote = await fetchTransactionStatusFromNetSuite(1017268, 'SalesOrd');
  soCloseAssert.match(remote.status_text, /(?:^|: )Closed$/);
  const plan = await soClosePlan(detail);
  soCloseAssert.ok(plan.orders[0].lines.every(line => line.closed));
  for (const line of plan.orders[0].lines) {
    const before = soCloseCheckpoint.plan.orders[0].lines.find(row => row.remoteLineId === line.remoteLineId);
    soCloseAssert.ok(before); soCloseAssert.equal(line.itemId, before.itemId);
    soCloseAssert.equal(line.queryFingerprint, before.queryFingerprint);
  }
  const local = (await query('SELECT status,status_text FROM sales_orders WHERE netsuite_id=1017268')).rows[0];
  soCloseAssert.equal(local.status, 'closed'); soCloseAssert.equal(local.status_text, 'Closed');
  soCloseAssert.deepEqual(await soCloseProtected(), soCloseCheckpoint.protectedRequests);
  console.log(JSON.stringify({ recovered: true, requestRef: detail.requestRef, salesOrderRef: detail.salesOrderRef,
    netsuiteStatus: remote.status_text, requestStatus: detail.status, closeStatus: detail.closeStatus,
    transport: 'REST record API', protectedRequestsUnchanged: true, writes: soCloseWrites }));
}
try {
  await soClosePriority.withOperatorNetSuitePriority(async () => {
    if (soCloseMode === 'preflight') {
      soCloseAssert.equal(soCloseFs.existsSync(soClosePath), false, 'Preserve the existing recovery checkpoint');
      const before = await soCloseRepo.getSpecialStockCase(64, { audience: 'scm' }); soCloseIdentity(before);
      soCloseAssert.equal(before.closeStatus, 'closure_pending'); soCloseAssert.equal(before.closureReason, 'tested');
      const row = (await query('SELECT closure_requested_by,closure_requested_at FROM sales_special_stock_cases WHERE request_id=64')).rows[0];
      soCloseAssert.equal(row.closure_requested_by, '6d9d3766-27e1-4038-8cf8-d02b2ba1599e'); soCloseAssert.ok(row.closure_requested_at);
      const operator = (await query('SELECT yard_location_ids FROM operators WHERE id=$1', [row.closure_requested_by])).rows[0];
      soCloseAssert.ok(operator.yard_location_ids.map(Number).includes(before.storeLocationId));
      const plan = await soClosePlan(before);
      soCloseCheckpoint = { revision: before.revision, reason: before.closureReason, plan,
        context: { operatorId: row.closure_requested_by, authorizedStoreLocationIds: operator.yard_location_ids.map(Number) }, protectedRequests: await soCloseProtected() };
      soCloseFs.writeFileSync(soClosePath, JSON.stringify(soCloseCheckpoint), { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ prepared: true, requestRef: before.requestRef, salesOrderRef: before.salesOrderRef,
        revision: before.revision, purchaseOrderId: null, planned: false, openLines: plan.orders[0].lines.filter(line => !line.closed).map(line => line.line), writes: 0 }));
    } else {
      soCloseAssert.ok(['apply', 'finish', 'verify'].includes(soCloseMode));
      soCloseCheckpoint = JSON.parse(soCloseFs.readFileSync(soClosePath));
      soCloseAssert.deepEqual(await soCloseProtected(), soCloseCheckpoint.protectedRequests);
      if (soCloseMode === 'apply' || soCloseMode === 'finish') {
        const current = await soCloseRepo.getSpecialStockCase(64, { audience: 'scm' }); soCloseIdentity(current);
        soCloseAssert.equal(current.closeStatus, 'closure_pending');
        if (soCloseMode === 'finish') {
          soCloseAssert.equal(current.closureReview.status, 'attention'); soCloseAssert.equal(current.closureReview.remoteStarted, true);
          soCloseAssert.equal(current.closureReview.confirmedBy, soCloseCheckpoint.context.operatorId);
          soCloseAssert.deepEqual(current.closureReviewPlan, soCloseCheckpoint.plan);
          const closed = await soClosePlan(current);
          soCloseAssert.ok(closed.orders[0].lines.every(line => line.closed));
          for (const line of closed.orders[0].lines) soCloseAssert.equal(line.queryFingerprint,
            soCloseCheckpoint.plan.orders[0].lines.find(before => before.remoteLineId === line.remoteLineId)?.queryFingerprint);
        } else {
          soCloseAssert.equal(current.revision, soCloseCheckpoint.revision);
          // Compare persisted JSON; optional undefined discount units are omitted on disk.
          soCloseAssert.deepEqual(JSON.parse(JSON.stringify(await soClosePlan(current))), soCloseCheckpoint.plan);
        }
        const service = soCloseService.createSpecialClosureService({
          preparePlan: input => prepareSpecialClosurePlanInNetSuite(input, soCloseBoundary),
          applyPlan: plan => applySpecialClosurePlanInNetSuite(plan, soCloseBoundary)
        });
        await service.requestClosure(64, { expectedRevision: current.revision, reason: soCloseCheckpoint.reason }, soCloseCheckpoint.context);
      }
      await soCloseVerify();
    }
  });
} finally { await soCloseDb.closeDb(); }
