import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pool, query, withTransaction, closeDb } from "../src/db.js";
import { getDeliveryOrder, listDeliveryOrders } from "../src/delivery-repository.js";
import { getReceivingOrder, listReceivingOrders } from "../src/receiving-repository.js";
import { getDriverDayJobs } from "../src/driver-repository.js";
import { loadDispatchOrdersForResponse } from "../src/server.js";
import { listFulfilledTransferStates } from "../src/dispatch-fulfilled-to-repository.js";
import { readTransferCleanupState, createTransferCleanupManifest, transferCleanupSummary } from "./to-cleanup-repository.mjs";
pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";
const directory = process.argv[2] || "test-artifacts/to-cleanup-20260915/production";
const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8"));
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const key = value => String(value || "").trim().toLowerCase();
try {
  const report = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const state = await readTransferCleanupState(), byId = new Map(state.orders.map(order => [String(order.netsuite_id), order]));
    const repeat = createTransferCleanupManifest(state, manifest.remote, { candidateIds: manifest.entries.map(entry => entry.id) });
    assert.equal(repeat.entries.length, manifest.entries.length); assert.equal(transferCleanupSummary(repeat).changedOrders, 0);
    const planning = await listFulfilledTransferStates(manifest.entries.map(entry => entry.ref));
    for (const entry of manifest.entries) {
      assert.equal(byId.get(entry.id).outbound_operator_status, "loaded", entry.ref);
      if (entry.receiving) assert.equal(byId.get(entry.id).receiving_status, "received", entry.ref);
      if (entry.guard.locallyCompleted) {
        assert.equal(planning.get(key(entry.ref))?.eligible, false, entry.ref);
        for (const field of ["status", "status_text", "fulfillment_status", "fulfilled_at", "last_item_fulfillment_id"]) assert.deepEqual(byId.get(entry.id)[field], entry.before.order[field], entry.ref);
      }
    }
    const active = await listDeliveryOrders({ status: "active", orderType: "transfer_order" });
    const receiving = await listReceivingOrders({ orderType: "transfer_order" });
    const cleaned = new Set(manifest.entries.map(entry => entry.ref)), received = new Set(manifest.entries.filter(entry => entry.receiving).map(entry => entry.ref));
    assert(!active.some(order => cleaned.has(order.tranid))); assert(!receiving.some(order => received.has(order.tranid)));
    const cos = (await query("SELECT co_ref,source_order_ref FROM local_co_orders WHERE details->>'sourceOrderType'='TO' AND status NOT IN ('cancelled','completed') ORDER BY co_ref")).rows;
    const coResults = [];
    for (const co of cos) {
      const detail = await getDeliveryOrder(co.co_ref);
      coResults.push({ ref: co.co_ref, source: co.source_order_ref, status: detail?.operator_status });
      if (cleaned.has(co.source_order_ref)) assert.equal(detail?.operator_status, "loaded", co.co_ref);
    }
    const plans = (await query(`SELECT p.id,p.status,s.orders,s.trucks FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.plan_date=$1::date ORDER BY p.id`, [date])).rows;
    const drivers = (await query("SELECT id,login FROM dispatch_drivers WHERE active")).rows;
    const driverById = new Map(drivers.map(row => [String(row.id), row.login]));
    const refs = new Set(), logins = new Set(); let loadCount = 0;
    for (const plan of plans) for (const truck of plan.trucks || []) for (const load of truck.loads || []) {
      loadCount++;
      for (const ref of [...(load.orders || []).map(value => typeof value === "object" ? value.id : value), ...(load.stops || []).flatMap(stop => [stop.orderId, ...(stop.orderRefs || [])])]) if (ref) refs.add(key(ref));
      const login = load.driverLogin || driverById.get(String(load.driverId)) || truck.driverLogin || driverById.get(String(truck.driverId));
      if (login && plan.status === "confirmed") logins.add(login);
    }
    for (const order of plans.flatMap(plan => plan.orders || [])) if (refs.has(key(order.id))) for (const child of order.childOrders || []) refs.add(key(child));
    const routes = [];
    for (const login of logins) {
      const route = await getDriverDayJobs(login, { date });
      for (const job of route.jobs) for (const ref of job.orderRefs || []) refs.add(key(ref));
      routes.push({ driver: login, jobs: route.jobs.length, pending: route.jobs.filter(job => job.status !== "complete").length,
        transferJobs: route.jobs.filter(job => (job.orderRefs || []).some(ref => key(ref).startsWith("to"))).map(job => ({ id: job.jobId, type: job.stopType, status: job.status, refs: job.orderRefs })) });
    }
    const todayTransfers = state.orders.filter(order => refs.has(key(order.tranid))), operator = [];
    for (const row of todayTransfers) {
      const delivery = await getDeliveryOrder(row.netsuite_id, { includeNetSuiteClosed: true });
      const receipt = await getReceivingOrder(row.netsuite_id, { includeNetSuiteClosed: true });
      operator.push({ ref: row.tranid, id: row.netsuite_id, found: Boolean(delivery), loaded: delivery?.operator_status,
        receiving: receipt?.receipt_status, warnings: delivery?.warning_count, lines: delivery?.lines.length,
        skippedForReview: manifest.held.some(entry => entry.ref === row.tranid) });
    }
    const samples = [...new Set([...todayTransfers.map(row => row.tranid), ...manifest.entries.filter(entry => !entry.guard.locallyCompleted).slice(0, 3).map(entry => entry.ref),
      ...manifest.entries.filter(entry => entry.guard.locallyCompleted).slice(0, 3).map(entry => entry.ref)])];
    const search = [];
    for (const ref of samples) {
      const result = await loadDispatchOrdersForResponse({ type: "TO", search: ref, exactOrderRefs: [ref], includeCompletedScmSearch: true });
      const order = result.find(row => row.id === ref);
      search.push({ ref, found: Boolean(order), completed: order?.dispatchCompletionStatus,
        completedPlanningException: order?.dispatchFulfilledTransferPlanningEligible, restricted: order?.dispatchPlanningRestricted, reason: order?.dispatchPlanningRestrictionReason });
    }
    return { verifiedAt: new Date().toISOString(), date, timeZone: "America/Toronto", loaded: manifest.entries.length,
      received: manifest.entries.filter(entry => entry.receiving).length, skipped: manifest.held, excluded: manifest.unchanged.length,
      idempotent: true, removedFromActiveDelivery: true, removedFromPendingReceiving: true,
      localReplanningBlocked: manifest.entries.filter(entry => entry.guard.locallyCompleted).length,
      netSuitePlanningAllowed: manifest.entries.filter(entry => !entry.guard.locallyCompleted && planning.get(key(entry.ref))?.eligible).length,
      planningRestrictions: manifest.entries.filter(entry => !entry.guard.locallyCompleted && !planning.get(key(entry.ref))?.eligible).map(entry => ({ ref: entry.ref, state: planning.get(key(entry.ref)) })),
      receiptPending: manifest.entries.filter(entry => !entry.receiving).map(entry => entry.ref), coResults,
      today: { plans: plans.map(plan => ({ id: plan.id, status: plan.status })), loads: loadCount, routes, operator, search,
        blockers: operator.filter(order => !order.found || order.skippedForReview) } };
  }, { rollback: true });
  writeFileSync(`${directory}/runtime-verification.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, skipped: report.skipped.length, planningRestrictions: report.planningRestrictions.length,
    today: { plans: report.today.plans.length, loads: report.today.loads, routes: report.today.routes.length, transfers: report.today.operator.length, blockers: report.today.blockers } }));
} finally { await closeDb(); }
