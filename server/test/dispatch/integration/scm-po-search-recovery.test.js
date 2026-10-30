import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import pg from "pg";
import fc from "fast-check";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import * as catalog from "../../../src/scm-purchase-order-catalog-repository.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";

if (process.env.MBT_TEST_ISOLATED !== "1") throw new Error("Disposable test database required");
after(closeDb);
beforeEach(async () => {
  await query("TRUNCATE scm_purchase_order_catalog_refresh_outbox, scm_purchase_order_catalog_entries");
});

async function enqueue(ref = "PO-RECOVERY") {
  return catalog.enqueueScmPurchaseOrderCatalogRefresh({ orderRef: ref, source: "recovery-test" });
}
async function age(id) {
  await query("UPDATE scm_purchase_order_catalog_refresh_outbox SET updated_at = now() - interval '6 minutes' WHERE id=$1", [id]);
}
async function state(id) {
  return (await query("SELECT status, last_error FROM scm_purchase_order_catalog_refresh_outbox WHERE id=$1", [id])).rows[0];
}
async function publish(ref) {
  await catalog.upsertScmPurchaseOrderCatalog({ orders: [{ id: ref, scm: { status: "Queued" } }], source: "recovery-test" });
}

test("abandoned running refreshes recover while recent claims stay owned", async () => {
  const abandoned = await enqueue();
  const recent = await enqueue("PO-RECENT");
  await catalog.claimScmPurchaseOrderCatalogRefreshes();
  await age(abandoned.id);
  const recovered = await catalog.claimScmPurchaseOrderCatalogRefreshes();
  assert.deepEqual(recovered.map(row => row.id), [abandoned.id]);
  assert.equal((await state(recent.id)).status, "running");
  assert.ok(recovered[0].claimToken);
});

test("superseded workers cannot publish or complete a newer claim", async () => {
  await enqueue();
  const [old] = await catalog.claimScmPurchaseOrderCatalogRefreshes();
  await age(old.id);
  const [current] = await catalog.claimScmPurchaseOrderCatalogRefreshes();
  assert.ok(current, "the expired claim must be recovered");
  assert.notEqual(old.claimToken, current.claimToken);
  let obsoleteRan = false;
  const stale = await catalog.processScmPurchaseOrderCatalogRefresh(old, async () => { obsoleteRan = true; });
  assert.equal(stale, false);
  assert.equal(obsoleteRan, false);
  await catalog.completeScmPurchaseOrderCatalogRefresh(old.id, old.claimToken);
  await catalog.failScmPurchaseOrderCatalogRefresh(old.id, new Error("obsolete failure"), old.claimToken);
  assert.equal((await state(current.id)).status, "running");
  assert.equal(await catalog.processScmPurchaseOrderCatalogRefresh(current, () => publish("PO-PUBLISHED")), true);
  assert.equal((await state(current.id)).status, "complete");
  assert.equal((await query("SELECT order_ref FROM scm_purchase_order_catalog_entries")).rows[0].order_ref, "PO-PUBLISHED");
});

test("active refresh locks survive expiry and concurrent enqueue is retained", async () => {
  await enqueue();
  const [claimed] = await catalog.claimScmPurchaseOrderCatalogRefreshes();
  await age(claimed.id);
  const row = (await query("SELECT updated_at::text AS token FROM scm_purchase_order_catalog_refresh_outbox WHERE id=$1", [claimed.id])).rows[0];
  claimed.claimToken = row.token;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const running = catalog.processScmPurchaseOrderCatalogRefresh(claimed, async () => {
    entered();
    await gate;
    await publish("PO-ACTIVE");
  });
  let later;
  try {
    await started;
    assert.deepEqual(await catalog.claimScmPurchaseOrderCatalogRefreshes(), [], "active work is protected by its row lock");
    later = enqueue();
  } finally {
    release();
    await running;
  }
  const next = await later;
  assert.notEqual(next.id, claimed.id, "a concurrent change must have a subsequent refresh");
  assert.equal((await state(next.id)).status, "pending");
});

test("failed refresh rolls back publication and remains retryable", async () => {
  await enqueue();
  const [claimed] = await catalog.claimScmPurchaseOrderCatalogRefreshes();
  await assert.rejects(catalog.processScmPurchaseOrderCatalogRefresh(claimed, async () => {
    await publish("PO-UNCOMMITTED");
    throw new Error("fixture failure");
  }), /fixture failure/u);
  assert.equal((await query("SELECT count(*)::int AS n FROM scm_purchase_order_catalog_entries")).rows[0].n, 0);
  await catalog.failScmPurchaseOrderCatalogRefresh(claimed.id, new Error("fixture failure"), claimed.claimToken);
  assert.deepEqual(await state(claimed.id), { status: "failed", last_error: "fixture failure" });
  await query("UPDATE scm_purchase_order_catalog_refresh_outbox SET available_at=now() WHERE id=$1", [claimed.id]);
  const [retry] = await catalog.claimScmPurchaseOrderCatalogRefreshes();
  assert.ok(retry);
  assert.equal(await catalog.processScmPurchaseOrderCatalogRefresh(retry, () => publish("PO-RETRIED")), true);
});

test("claim ownership is exclusive across concurrent workers and case-insensitive enqueue", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async count => {
    await query("TRUNCATE scm_purchase_order_catalog_refresh_outbox");
    const refs = Array.from({ length: count }, (_, i) => `PO-PROPERTY-${i}`);
    await Promise.all(refs.flatMap(ref => [enqueue(ref), enqueue(ref.toLowerCase())]));
    const claims = (await Promise.all(Array.from({ length: 3 }, () => catalog.claimScmPurchaseOrderCatalogRefreshes({ limit: 3 })))).flat();
    assert.equal(claims.length, count);
    assert.equal(new Set(claims.map(row => row.id)).size, count);
    assert.ok(claims.every(row => row.claimToken));
  }), { numRuns: 8, seed: 4160 });
});

test("application refresh tick commits successful work and records retryable failure", async () => {
  const { scmPurchaseOrderCatalogTick } = await import("../../../src/server.js");
  await enqueue("PO-RECOVERY-NO-SOURCE");
  const failed = await enqueue("PO-RECOVERY-FAIL");
  await query(`CREATE FUNCTION scm_catalog_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'complete' AND OLD.order_ref = 'PO-RECOVERY-FAIL' THEN
        RAISE EXCEPTION 'fixture completion failure';
      END IF;
      RETURN NEW;
    END $$`);
  try {
    await query(`CREATE TRIGGER scm_catalog_fixture_failure BEFORE UPDATE ON scm_purchase_order_catalog_refresh_outbox
      FOR EACH ROW EXECUTE FUNCTION scm_catalog_fixture_failure()`);
    const result = await scmPurchaseOrderCatalogTick();
    assert.equal(result.claimed, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(await state(failed.id), { status: "failed", last_error: "fixture completion failure" });
  } finally {
    await query("DROP TRIGGER IF EXISTS scm_catalog_fixture_failure ON scm_purchase_order_catalog_refresh_outbox");
    await query("DROP FUNCTION scm_catalog_fixture_failure()");
  }
});

test("one PO search does not evaluate unrelated linked delivery work", async () => {
  await withTransaction(async () => {
    await query(`INSERT INTO purchase_orders (netsuite_id,tranid,vendor,status,status_text,destination_location_id,destination_location,initial_scm_status,netsuite_active)
      SELECT 9970416000+i, 'PO-SEARCH-SCOPE-'||i, 'Scope Vendor', 'B', 'Pending Receipt', 1, '3445', 'Queued', true FROM generate_series(0,30) i`);
    await query(`INSERT INTO purchase_order_lines (purchase_order_id,line_id,item_id,item_name,sku,item_type,quantity,piece_qty,to_pcs,unit,netsuite_active)
      SELECT 9970416000+i,1,5055,'Scope Item','SCOPE','InvtPart',10,10,1,'PC',true FROM generate_series(0,30) i`);
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,customer,status,status_text,netsuite_active) VALUES (9970416999,'SO-SEARCH-SCOPE','Scope Customer','B','Pending Fulfillment',true)`);
    const line = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,quantity,piece_qty,to_pcs,unit,netsuite_active)
      VALUES (9970416999,1,5055,'Scope Item',500,500,1,'PC',true) RETURNING id`)).rows[0].id;
    await query(`INSERT INTO dispatch_so_po_allocations (sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,allocated_piece_qty,dispatch_target_ref,dispatch_target_line_key)
      SELECT 9970416999,'SO-SEARCH-SCOPE',$1,purchase_order_id,'PO-SEARCH-SCOPE-'||(purchase_order_id-9970416000),id,5055,10,10,'SO-SEARCH-SCOPE','scope-'||id
      FROM purchase_order_lines WHERE purchase_order_id BETWEEN 9970416001 AND 9970416030`, [line]);
    await catalog.upsertScmPurchaseOrderCatalog({ orders: [{ id: "PO-SEARCH-SCOPE-0", scm: { status: "Queued" } }] });
    let captured;
    const original = pg.Client.prototype.query;
    pg.Client.prototype.query = function (sql, ...args) {
      if (typeof sql === "string" && sql.includes("WITH active_po_split_alloc AS MATERIALIZED")) captured = [sql, args[0]];
      return original.call(this, sql, ...args);
    };
    let result;
    try { result = await catalog.listScmPurchaseOrderCatalog({ search: "po-search-scope-0" }); }
    finally { pg.Client.prototype.query = original; }
    assert.deepEqual(result.orders.map(row => [row.id, row.scm.status]), [["PO-SEARCH-SCOPE-0", "Queued"]]);
    const plan = (await query("EXPLAIN (ANALYZE, FORMAT JSON) " + captured[0], captured[1])).rows[0]["QUERY PLAN"][0];
    const nodes = [];
    const walk = node => { nodes.push(node); (node.Plans || []).forEach(walk); };
    walk(plan.Plan);
    for (const name of ["linked_po_allocations", "fully_linked_po"]) {
      const node = nodes.find(candidate => candidate["Subplan Name"] === `CTE ${name}`);
      assert.ok(node, `measure ${name}`);
      assert.equal(node["Actual Rows"], 0, `${name} must not calculate unrelated orders`);
    }
  }, { rollback: true });
});

test("non-string Driver references cannot become linked delivery evidence", async () => {
  await withTransaction(async () => {
    const poId = 9970416100;
    const poRef = "PO-SEARCH-DRIVER-REF-TYPE";
    await query(`INSERT INTO purchase_orders (netsuite_id,tranid,vendor,status,status_text,destination_location_id,destination_location,initial_scm_status,netsuite_active)
      VALUES ($1,$2,'Reference Vendor','B','Pending Receipt',1,'3445','Queued',true)`, [poId, poRef]);
    const poLine = (await query(`INSERT INTO purchase_order_lines (purchase_order_id,line_id,item_id,item_name,sku,item_type,quantity,piece_qty,to_pcs,unit,netsuite_active)
      VALUES ($1,1,5055,'Reference Item','REFERENCE','InvtPart',10,10,1,'PC',true) RETURNING id`, [poId])).rows[0].id;
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,customer,status,status_text,netsuite_active)
      VALUES ($1,'4160','Reference Customer','B','Pending Fulfillment',true)`, [poId + 1]);
    const soLine = (await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,quantity,piece_qty,to_pcs,unit,netsuite_active)
      VALUES ($1,1,5055,'Reference Item',10,10,1,'PC',true) RETURNING id`, [poId + 1])).rows[0].id;
    await query(`INSERT INTO dispatch_so_po_allocations (sales_order_id,sales_order_ref,sales_line_id,po_order_id,po_order_ref,po_line_id,item_id,allocated_sales_qty,allocated_piece_qty,dispatch_target_ref,dispatch_target_line_key)
      VALUES ($1,'4160',$2,$3,$4,$5,5055,10,10,'4160','reference-line')`, [poId + 1, soLine, poId, poRef, poLine]);
    const currentStatus = async () => (await listScmSchedule({ exactRefs: [poRef] }))[0].calculatedStatus;
    assert.equal(await currentStatus(), "Direct ship");
    const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2026-10-29','confirmed') RETURNING id")).rows[0].id;
    const details = JSON.stringify({ orderTypes: ["SO"], orders: [{ orderRef: "4160", orderType: "SO" }] });
    for (const [name, refs, expected] of [["number", [4160], "Direct ship"], ["string", ["4160"], "In Transit"]]) {
      await query(`INSERT INTO driver_job_records(job_id,plan_id,plan_date,driver_login,load_id,stop_id,stop_type,order_refs,status,completed_at,job_details)
        VALUES($1,$2,'2026-10-29','reference-driver','reference-load',$1,'pickup',$3::jsonb,'complete',now(),$4::jsonb)`,
      ["po-search-reference-" + name, plan, JSON.stringify(refs), details]);
      assert.equal(await currentStatus(), expected, name + " references must preserve JSON membership semantics");
    }
  }, { rollback: true });
});
