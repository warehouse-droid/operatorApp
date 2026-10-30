import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { pool, query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { loadDispatchOrdersForResponse } from '../../../src/server.js';
import { enrichDispatchOrdersWithDependencies, listOrderDependencies } from '../../../src/order-dependency-repository.js';
import { enrichScmScheduleWithReconciliation } from '../../../src/scm-reconciliation-repository.js';
import { listDispatchOrderCompletionStatuses } from '../../../src/dispatch-completion-repository.js';
import { listReconciliationCompletedOperationallyPendingDispatchRefs } from '../../../src/dispatch-history-mode.js';
import { chromium } from '@playwright/test';
import { config } from '../../../src/config.js';
import { getDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } from '../../../src/dispatch-planner-v2-repository.js';

// Observe real query results, including work discarded by the application.
// All data below is synthetic and belongs to the disposable database.
let observed = null;
pool.on('connect', client => {
  const original = client.query.bind(client);
  client.query = (...args) => {
    const record = observed;
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const params = Array.isArray(args[1]) ? args[1] : [];
    const start = performance.now();
    const done = result => record?.push({ sql, params, rows: result?.rowCount, ms: performance.now() - start });
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (error, result) => { done(result); callback(error, result); };
      return original(...args);
    }
    return original(...args).then(result => { done(result); return result; });
  };
});
async function measure(operation) {
  const statements = []; observed = statements;
  try { return { value: await operation(), statements }; } finally { observed = null; }
}
let fixture;
let selectedPlan;
before(async () => {
  fixture = await createDispatchV2Fixture();
  selectedPlan = await fixture.seedPlan({ date: '2041-01-01', refs: ['LATENCY-LOCAL'] });
  await fixture.seedPlan({ date: '2041-01-02', refs: Array.from({ length: 100 }, (_, n) => `LATENCY-UNRELATED-${n}`) });
  await query(`INSERT INTO dispatch_custom_orders (ref_number,pickup_location,dropoff_location,order_details,weight_lbs,stop_minutes,status)
    VALUES ('LATENCY-LOCAL','3445','100 Isolated Road','Local latency fixture',100,10,'open')`);
  await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,sales_order_type,fulfillment_status,netsuite_active,outbound_location_id)
    SELECT 890000000000+n,'LATENCY-SO-'||n,'B','Sales Order : Pending Fulfillment','Delivery','open',true,1
    FROM generate_series(1,2000) n`);
  await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,item_type,item_type_text,quantity,unit,netsuite_backordered_qty,netsuite_active)
    SELECT 890000000000+n,1,890000000000+n,'Latency item','InvtPart','Inventory Item',10,'EA',4,true FROM generate_series(1,2000) n`);
  await query(`INSERT INTO transfer_orders (netsuite_id,tranid,status,status_text,netsuite_active)
    SELECT 890100000000+n,'LATENCY-TO-'||n,'B','Transfer Order : Pending Fulfillment',true FROM generate_series(1,10) n`);
  await query(`INSERT INTO order_dependencies (sales_order_id,sales_order_ref,dispatch_target_ref,transfer_order_id,transfer_order_ref,
    dependency_mode,source_location_id,source_location,accounting_destination_location_id,accounting_destination_location)
    SELECT 890000000000+n,'LATENCY-SO-'||n,'LATENCY-SO-'||n,890100000000+n,'LATENCY-TO-'||n,
      'yard_replenishment',1,'3445',15,'12441' FROM generate_series(1,10) n`);
  await query(`INSERT INTO scm_reconciliation_order_state (order_kind,source_order_netsuite_id,source_order_ref,reconciliation_status,
    application_status,quantity_summary,reconciled_at,ordered_qty,received_qty)
    SELECT 'PO',890200000000+n,'LATENCY-PO-'||n,'current','Completed',
      jsonb_build_object('targets',jsonb_build_object('LATENCY-PO-'||n||'-S1',jsonb_build_object('applicationStatus','Completed','ordered',10,'received',10))),now(),10,10
    FROM generate_series(1,200) n`);
  await query(`INSERT INTO scm_transport_schedule (order_kind,order_ref,status,method)
    SELECT 'PO','LATENCY-PO-'||n||'-S1','Queued','MBT' FROM generate_series(1,200) n`);
  await query(`INSERT INTO dispatch_order_completion_events (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id)
    SELECT 'PO','LATENCY-HISTORY-'||n,now(),'reconciliation','latency-history-'||n FROM generate_series(1,12000) n`);
  await query(`SELECT dispatch_record_order_completion('PO','LATENCY-PO-1-S1',now(),'reconciliation','latency-reconciled')`);
  await query(`SELECT dispatch_record_order_completion('PO','LATENCY-PO-2',now(),'scm_vendor','latency-vendor',
    NULL,NULL,NULL,'operator','latency-test','Synthetic vendor completion','{"netSuiteUpdated":false}'::jsonb)`);
  await query('ANALYZE dispatch_order_completion_events');
});
after(async () => { await fixture?.close(); });

test('one local order retains its assignment without loading other plan snapshots', async () => {
  const { value, statements } = await measure(() => loadDispatchOrdersForResponse({ search: 'LATENCY-LOCAL', exactOrderRefs: ['LATENCY-LOCAL'], includeCompletedScmSearch: true }));
  const order = value.find(row => row.id === 'LATENCY-LOCAL');
  assert.ok(order);
  assert.equal(String(order.dispatchPlanId), selectedPlan.id);
  const reads = statements.filter(row => row.sql.includes('FROM dispatch_plan_order_assignments assignment'));
  assert.ok(reads.length);
  assert.ok(reads.every(row => row.rows <= 1), `unrelated assignments loaded: ${reads.map(row => row.rows)}`);
});

test('group members retain shortages and TO requirements while unrelated orders stay unread', async () => {
  const { value, statements } = await measure(() => enrichDispatchOrdersWithDependencies([
    { id: 'LATENCY-GROUP', type: 'SO', childOrderDetails: [{ id: 'LATENCY-SO-1-S1', originalOrderId: 'LATENCY-SO-1' }] }
  ]));
  assert.equal(value[0].dependencyUncoveredQuantity, 4);
  assert.deepEqual(value[0].orderDependencies.map(row => row.transferOrderRef), ['LATENCY-TO-1']);
  assert.equal(value[0].dependencyWaitingForTransfer, true);
  const dependencies = statements.find(row => row.sql.includes('SELECT d.*'));
  const shortages = statements.find(row => row.sql.includes('AS shortage_quantity'));
  assert.equal(dependencies?.rows, 1, 'only relevant dependency records should cross the DB boundary');
  assert.equal(shortages?.rows, 1, 'only relevant shortage rows should cross the DB boundary');
});

test('split reconciliation retains parent quantities without loading other states', async () => {
  const { value, statements } = await measure(() => enrichScmScheduleWithReconciliation([
    { orderKind: 'PO', orderRef: 'LATENCY-PO-1-S1', status: 'Queued' }
  ], { includeDetails: true }));
  assert.equal(value.length, 1);
  assert.equal(value[0].reconciliationStatus, 'ok');
  assert.equal(value[0].reconciliation.quantities.received, 10);
  const states = statements.find(row => row.sql.includes('SELECT state.*'));
  assert.equal(states?.rows, 1, 'unrelated reconciliation payloads must stay in the database');
});

test('SCM groups retain every member reconciliation and empty feeds do no global reads', async () => {
  const group = (await query("INSERT INTO scm_schedule_groups(group_ref) VALUES ('LATENCY-PO-GROUP') RETURNING id")).rows[0];
  await query(`INSERT INTO scm_schedule_group_members(group_id,order_kind,order_ref)
    VALUES ($1,'PO','LATENCY-PO-1-S1'),($1,'PO','LATENCY-PO-2-S1')`, [group.id]);
  const { value, statements } = await measure(() => enrichScmScheduleWithReconciliation([
    { orderKind: 'PO', orderRef: 'LATENCY-PO-GROUP', status: 'Queued' }
  ], { includeDetails: true }));
  assert.equal(value[0].reconciliation.quantities.received, 20);
  assert.equal(statements.find(row => row.sql.includes('SELECT state.*'))?.rows, 2);
  const empty = await measure(async () => Promise.all([
    enrichDispatchOrdersWithDependencies([]), enrichDispatchOrdersWithDependencies([{}]),
    listOrderDependencies({ orderRefs: [] }), enrichScmScheduleWithReconciliation([])
  ]));
  assert.deepEqual(empty.value, [[], [{}], [], []]);
  assert.equal(empty.statements.length, 0);
});

function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)]; }
test('completion lookup preserves canonical priority without ranking unrelated history', async () => {
  const requests = [{ orderKind: 'PO', orderRef: 'LATENCY-PO-1-S1' }, { orderKind: 'PO', orderRef: 'LATENCY-PO-2' }];
  const { value, statements } = await measure(() => listDispatchOrderCompletionStatuses(requests));
  assert.deepEqual(value.map(row => row.completionEvidenceType).sort(), ['reconciliation', 'scm_vendor']);
  const statement = statements.at(-1);
  const { rows } = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.params);
  const ranked = nodes(rows[0]['QUERY PLAN'][0].Plan).filter(row => row['Node Type'] === 'WindowAgg');
  assert.ok(ranked.every(row => row['Actual Rows'] * row['Actual Loops'] <= 2), 'single-order completion reads must not rank the complete history');
  const pending = await listReconciliationCompletedOperationallyPendingDispatchRefs({ candidateRefs: ['LATENCY-PO-1-S1', 'LATENCY-PO-2-S1'] });
  assert.deepEqual([...pending], ['latency-po-1-s1'], 'quantity reconciliation is not a physical delivery; vendor completion is');
});

test('requested reconciliation targets do not join every unrelated schedule to every source', async () => {
  const { value, statements } = await measure(() => listReconciliationCompletedOperationallyPendingDispatchRefs({ candidateRefs: ['LATENCY-PO-1-S1'] }));
  assert.deepEqual([...value], ['latency-po-1-s1']);
  const statement = statements.find(row => row.sql.includes('target.target_state'));
  const { rows } = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, statement.params);
  const joins = nodes(rows[0]['QUERY PLAN'][0].Plan).filter(row => /Join|Nested Loop/.test(row['Node Type']));
  assert.ok(joins.every(row => row['Actual Rows'] * row['Actual Loops'] <= 200), 'a one-target read must not cross-join the 200 sources and 200 schedules');
});

test('completion lookup matches the canonical projection for mixed evidence, case, duplicates and corrected VRMA identity', async () => {
  const requests = [];
  for (let n = 0; n < 45; n++) {
    const kind = ['SO', 'PO', 'TO'][n % 3];
    const ref = `LATENCY-PROPERTY-${n}`;
    requests.push({ orderKind: kind, orderRef: ` ${ref.toLowerCase()} ` }, { orderKind: kind.toLowerCase(), orderRef: ref });
    for (const [i, evidence] of ['reconciliation', 'driver_job', 'direct_dependency', 'netsuite_fulfillment'].entries()) {
      await query(`INSERT INTO dispatch_order_completion_events (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id)
        VALUES ($1,$2,'2040-01-01'::timestamptz + $3*interval '1 hour',$4,$5)`,
      [kind, n % 2 ? ref : ref.toLowerCase(), n + i, evidence, `latency-property-${n}-${i}`]);
      if (kind === 'PO' && i === 1) { await query(`INSERT INTO dispatch_order_completion_events
        (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id)
        VALUES ('VRMA',$1,'2040-01-01','driver_job',$2)`, [ref, `latency-property-${n}-${i}`]); }
    }
  }
  requests.push({ orderKind: 'helper', orderRef: 'invalid' }, null, { orderKind: 'PO', orderRef: '' });
  const canonical = (await query(`SELECT completion_event_id::text AS id, order_kind AS kind, lower(btrim(order_ref)) AS ref
    FROM dispatch_order_completion_status WHERE order_ref ILIKE 'LATENCY-PROPERTY-%' AND order_kind <> 'VRMA'`)).rows;
  const actual = await listDispatchOrderCompletionStatuses(requests);
  const sorted = rows => rows.sort((a, b) => a.ref.localeCompare(b.ref));
  assert.deepEqual(sorted(actual.map(row => ({ id: row.completionEventId, kind: row.orderKind, ref: row.orderRef.trim().toLowerCase() }))), sorted(canonical));
  const empty = await measure(() => listDispatchOrderCompletionStatuses([null, { orderKind: 'bad', orderRef: 'bad' }]));
  assert.deepEqual(empty.value, []); assert.equal(empty.statements.length, 0);
});

test('browser local-order placement paints within 500ms and committed autosave finishes within 5s', { timeout: 30000 }, async () => {
  config.dispatch.plannerCommandMode = 'on';
  const refs = Array.from({ length: 36 }, (_, n) => `LATENCY-BOARD-${n}`);
  const seeded = await fixture.seedPlan({ date: '2041-01-03', refs });
  const saved = await getDispatchPlan(seeded.id);
  saved.orders = saved.orders.map((order, n) => ({ ...order, address: `${100 + n} Isolated Road`, pickupLocations: ['3445'],
    items: Array.from({ length: 8 }, (_, i) => ({ itemName: `SYNTHETIC-${n}-${i}`, quantity: 1, uom: 'EA' })) }));
  saved.trucks = Array.from({ length: 13 }, (_slot, n) => ({ id: `LATENCY-TRUCK-${n}`, plate: `LATENCY-TRUCK-${n}`, base: '3445',
    capacity: 100000, driverLogin: `latency-driver-${n}`, driver: `Latency driver ${n}`, loads: [{ id: `latency-load-${n}`,
      name: 'Load 1', driverLogin: `latency-driver-${n}`, start: '08:00', stops: refs.filter((_, i) => i % 13 === n)
        .map((ref, i) => ({ id: `latency-stop-${n}-${i}`, type: 'drop', orderId: ref })) }] }));
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1',
    [seeded.id, JSON.stringify(saved.orders), JSON.stringify(saved.trucks)]);
  await syncDispatchPlanOrderAssignments(saved); await syncDispatchPlanRelationEdges(saved);
  await query(`INSERT INTO dispatch_custom_orders (ref_number,pickup_location,dropoff_location,order_details,weight_lbs,stop_minutes,status)
    SELECT 'LATENCY-ADD-'||n,'3445','200 Isolated Road','Local latency fixture',100,10,'open' FROM generate_series(1,3) n`);
  const plan = await getDispatchPlan(seeded.id);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { authorization: `Bearer ${fixture.session.token}` } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/latency-browser', route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><link rel="stylesheet" href="/dispatch.css"><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>' }));
    // Keep external forecast/maps and background shell polling deterministic;
    // hydration, save, checkpoint, lease and persisted readback use the real app.
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (/forecast|google|samsara/.test(path)) {return route.fulfill({ json: { loads: [], stops: [] } });}
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/latency-browser`);
    const sessionId = await page.evaluate(() => dispatchSessionId);
    const lease = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
    await page.evaluate(({ plan: browserPlan, lease: browserLease, token }) => {
      localStorage.setItem('mbbs.staff.token', token);
      currentPlanDate = browserPlan.planDate; currentPlan = compactCurrentPlan(browserPlan);
      dispatchConfig = { plannerCommandMode: 'on', plannerOrderPoolMode: 'on', googleMapsEnabled: false, driverOrientedPlanning: false };
      dispatchSetupLoaded = true; dispatchPlannerSnapshotState = 'ready';
      orders = browserPlan.orders.map(normalizeOrder);
      for (let n = 1; n <= 3; n++) { orders.push(normalizeOrder({ id: `LATENCY-ADD-${n}`, type: 'CUSTOM', customer: 'Local fixture', address: '200 Isolated Road', catalogHydrated: false })); }
      orderCatalog = structuredClone(orders); trucks = structuredClone(browserPlan.trucks); fleet = structuredClone(trucks);
      drivers = trucks.map((truck, n) => ({ login: truck.driverLogin, name: `Latency driver ${n}`, active: true }));
      lastAcknowledgedPlanState = dispatchPlanWireState(browserPlan);
      planEditMode = true; planEditLeaseToken = browserLease;
      planEditLease = { active: true, sessionId: dispatchSessionId, planDate: currentPlanDate };
      selectedLoadId = 'latency-load-0'; loadPreviewOpen = true; localPlanDirty = false; activeOrderType = 'TO';
      render({ save: false });
    }, { plan, lease, token: fixture.session.token });
    const samples = [];
    for (let sampleIndex = 1; sampleIndex <= 3; sampleIndex++) {
      const placed = await page.evaluate(async n => {
        const ref = `LATENCY-ADD-${n}`;
        const start = performance.now();
        const card = document.querySelector(`[data-order="${ref}"]`);
        if (!card) {throw Error('Missing local order card');}
        card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await dispatchOrderHydrationPromises.get(ref);
        const hydrationMs = performance.now() - start;
        const current = document.querySelector(`[data-order="${ref}"]`);
        const transfer = new DataTransfer();
        current.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        document.querySelector('.preview-stop-list').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!findLoad('latency-load-0').load.stops.some(stop => stop.orderId === ref && stop.type === 'drop')) {throw Error(routeNotice || 'Order was not inserted');}
        return { ref, start, hydrationMs, paintMs: performance.now() - start };
      }, sampleIndex);
      await page.waitForFunction(() => !localPlanDirty && !saveInFlight && !saveQueued, undefined, { timeout: 15000 });
      const saveMs = await page.evaluate(start => performance.now() - start, placed.start);
      const stored = await getDispatchPlan(seeded.id);
      assert.ok(stored.trucks.some(truck => truck.loads.some(load => load.stops.some(stop => stop.orderId === placed.ref))));
      samples.push({ hydrationMs: Math.round(placed.hydrationMs), paintMs: Math.round(placed.paintMs), saveMs: Math.round(saveMs) });
      console.log(JSON.stringify({ latencySample: samples.at(-1) }));
      assert.ok(placed.paintMs < 500, `order placement ${placed.paintMs.toFixed(0)}ms exceeds 500ms`);
      assert.ok(saveMs < 5000, `durable acknowledgement ${saveMs.toFixed(0)}ms exceeds 5s`);
    }
    const manualStart = performance.now();
    await page.evaluate(() => forceSaveCurrentPlan());
    const manualMs = Math.round(performance.now() - manualStart);
    assert.ok(manualMs < 5000, `manual save/checkpoint took ${manualMs}ms`);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browserLatency: { trucks: 13, orders: 36, backgroundSales: 2000, completionHistory: 12000, samples, manualMs } }));
  } finally { await browser.close(); }
});
