// Read-only production rehearsal. Never saves a plan or appends completion.
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = name => pathToFileURL(path.resolve("src", name)).href;
const { pool, query, withTransaction, closeDb } = await import(source("db.js"));
pool.options.options = "-c jit=off -c default_transaction_read_only=on -c statement_timeout=45000";
const { loadDispatchOrdersForResponse } = await import(source("server.js"));
const { listFulfilledSalesDeliveryStates } = await import(source("dispatch-fulfilled-so-repository.js"));
const refs = ["SOR00030", "SOB119972", "SOA03472", "SOV02345", "SOA07771", "SOA07539-S1", "SOA08404-S2",
  "SOA05460-S1", "SOA05680-S2", "SOB116919-S1", "SOM05681", "SOR00107", "SOM05565", "SOA08614"];
try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const states = await listFulfilledSalesDeliveryStates(refs);
    const results = [];
    for (const ref of refs) {
      const started = performance.now();
      const orders = await loadDispatchOrdersForResponse({ type: "SO", search: ref, exactOrderRefs: [ref], includeCompletedScmSearch: true });
      const order = orders.find(row => row.id === ref);
      results.push({ ref, state: states.get(ref.toLowerCase()), searchReturned: Boolean(order),
        completed: order?.dispatchCompletionStatus, eligible: order?.dispatchFulfilledSalesPlanningEligible,
        restricted: order?.dispatchPlanningRestricted, evidence: order?.completionEvidenceType,
        durationMs: Math.round(performance.now() - started) });
      process.stderr.write(`Read-only fulfilled-SO verification: ${ref}\n`);
    }
    const lifecycle = (await query(`SELECT split_ref,active FROM dispatch_global_order_splits
      WHERE lower(split_ref)=ANY($1::text[])`, [refs.map(ref => ref.toLowerCase())])).rows;
    const groupMemberships = (await query(`SELECT member.group_ref,member.member_order_ref,groups.active
      FROM dispatch_delivery_group_members member JOIN dispatch_delivery_groups groups ON groups.group_ref=member.group_ref
      WHERE lower(member.member_order_ref)=ANY($1::text[])`, [refs.map(ref => ref.toLowerCase())])).rows;
    return { mode: "read-only", capturedAt: new Date().toISOString(), results, lifecycle, groupMemberships };
  }, { rollback: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await closeDb(); }
