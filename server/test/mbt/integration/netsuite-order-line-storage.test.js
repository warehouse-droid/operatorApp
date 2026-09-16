import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { upsertSalesOrderLines, upsertPurchaseOrderLines, upsertOutboundTransferOrderLines, upsertInboundTransferOrderLines } from "../../../src/order-sync-repository.js";
import { processNetSuiteOrderWebhook } from "../../../src/server.js";
import { getNetSuiteMirrorOrderSnapshot } from "../../../src/netsuite-mirror-repository.js";
import { config } from "../../../src/config.js";
import { fetchDeliveryOrderDetailsFromNetSuite, fetchDeliveryOrderDetailsBatchFromNetSuite,
  fetchPurchaseOrderDetailsFromNetSuite, fetchTransferOrderDetailsFromNetSuite,
  fetchTransactionProgressFromNetSuite, fetchScmReconciliationOrdersFromNetSuite } from "../../../src/netsuite.js";
import { startScmReconciliationRun } from "../../../src/scm-reconciliation-service.js";
import { refreshScmNetSuitePoHistory } from "../../../src/scm-netsuite-po-history-service.js";

after(closeDb);
const cases = [
  ["SO", "sales_orders", "sales_order_lines", "sales_order_id", "sales_order", upsertSalesOrderLines],
  ["PO", "purchase_orders", "purchase_order_lines", "purchase_order_id", "purchase_order", upsertPurchaseOrderLines],
  ["TO", "transfer_orders", "transfer_order_lines", "transfer_order_id", "transfer_order", upsertOutboundTransferOrderLines]
];
const line = (orderLine = 4) => ({ line_id: 990910001, orderLine, item_id: 9909102, item_name: "ORDERLINE-FIXTURE", item_type: "InvtPart",
  quantity: 10, unit: "EACH", location_id: 1, piece_qty: 10, to_pcs: 1, to_plt: 0, to_lyr: 0, to_sec: 0, item_weight: 0 });

test("schema provides separate nullable orderLine and observation time on all three line tables", async () => {
  const result = await query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
    AND table_name=ANY($1::text[]) AND column_name IN ('netsuite_order_line','netsuite_order_line_synced_at')`, [cases.map(c => c[2])]);
  assert.equal(result.rowCount, 6);
});

for (const [index, [kind, header, table, parent, type, upsert]] of cases.entries()) {
  test(`${kind} sync stores orderLine, legacy updates retain it, mirror carries it, and operational progress survives`, async () => {
    assert.equal(process.env.MBT_TEST_ISOLATED, "1");
    await withTransaction(async () => {
      const id = 990910000 + index;
      await query(`INSERT INTO ${header}(netsuite_id,tranid,status,status_text,netsuite_active) VALUES($1,$2,'B','Pending',true)`, [id, `ORDERLINE-${kind}`]);
      await upsert(id, [line()]);
      const read = () => query(`SELECT to_jsonb(l) AS data FROM ${table} l WHERE ${parent}=$1 ORDER BY id`, [id]);
      const first = (await read()).rows[0].data;
      assert.equal(Number(first.netsuite_order_line), 4);
      assert.ok(first.netsuite_order_line_synced_at);
      const progressColumn = kind === "PO" ? "received_piece_qty" : "packed_piece_qty";
      await query(`UPDATE ${table} SET ${progressColumn}=3 WHERE ${parent}=$1`, [id]);
      const legacy = line(); delete legacy.orderLine;
      await upsert(id, [legacy]);
      const retained = (await read()).rows[0].data;
      assert.equal(Number(retained.netsuite_order_line), 4);
      assert.equal(retained.netsuite_order_line_synced_at, first.netsuite_order_line_synced_at);
      assert.equal(Number(retained[progressColumn]), 3);
      await upsert(id, [line(17)]);
      assert.equal(Number((await read()).rows[0].data.netsuite_order_line), 17);
      const snapshot = await getNetSuiteMirrorOrderSnapshot(type, id);
      const mapped = Object.values(snapshot.stages).flat();
      assert.ok(mapped.some(l => Number(l.netsuite_order_line) === 17));
      if (kind === "TO") {
        await upsertInboundTransferOrderLines(id, [line(17)]);
        assert.deepEqual((await read()).rows.map(r => Number(r.data.netsuite_order_line)), [17, 17]);
      }
      const rekeyed = { ...legacy, line_id: legacy.line_id + 10 };
      await upsert(id, [rekeyed]);
      const updated = (await read()).rows.find(r => Number(r.data.line_id) === rekeyed.line_id).data;
      assert.equal(updated.netsuite_order_line, null, "a replacement stable key cannot inherit an old mapping");
    }, { rollback: true });
  });
}

test("application webhook persists explicit SO/PO orderLine without confusing it with the stable key", async () => {
  for (const [index, [kind, , table, parent]] of cases.slice(0, 2).entries()) {
    await withTransaction(async () => {
      const id = 990910100 + index;
      await processNetSuiteOrderWebhook({ id, recordType: kind === "SO" ? "salesorder" : "purchaseorder", tranid: `ORDERLINE-WH-${kind}`,
        status: "B", statusText: "Pending", locationId: 1, entityId: 1, lines: [{ lineUniqueKey: 990910101, orderLine: 17,
          itemId: 9909102, itemName: "ORDERLINE-WH", itemType: "InvtPart", quantity: 10, unit: "EACH", locationId: 1 }] },
      { scheduleDelayedStatus: false, emitEvents: false });
      const result = await query(`SELECT to_jsonb(l) AS data FROM ${table} l WHERE ${parent}=$1`, [id]);
      assert.equal(Number(result.rows[0].data.netsuite_order_line), 17);
      assert.equal(Number(result.rows[0].data.line_id), 990910101);
    }, { rollback: true });
  }
});

test("TO webhook preserves repeated items as separate mapped lines in both stages", async () => {
  await withTransaction(async () => {
    const id = 990910200;
    const lines = [1, 2, 3, 4].map((n, index) => ({ lineUniqueKey: 990910200 + n, orderLine: index < 2 ? 1 : 4,
      itemId: 9909102, itemName: "ORDERLINE-REPEATED", itemType: "InvtPart", quantity: 5,
      signedQuantity: n % 2 ? -5 : 5, locationId: n % 2 ? 1 : 28, unit: "EACH" }));
    await processNetSuiteOrderWebhook({ id, recordType: "transferorder", tranid: "ORDERLINE-WH-TO", status: "B", statusText: "Pending Fulfillment",
      sourceLocationId: 1, destinationLocationId: 28, lines }, { scheduleDelayedStatus: false, emitEvents: false });
    const result = await query("SELECT line_stage,netsuite_order_line FROM transfer_order_lines WHERE transfer_order_id=$1 ORDER BY line_stage,netsuite_order_line", [id]);
    assert.deepEqual(result.rows.map(row => [row.line_stage, Number(row.netsuite_order_line)]),
      [["outbound", 1], ["outbound", 4], ["receiving", 1], ["receiving", 4]]);
  }, { rollback: true });
});

test("split SO, PO and TO lines inherit mappings through exact parent relationships", async () => {
  await withTransaction(async () => {
    for (const [index, [kind, header, table, parent, , upsert]] of cases.entries()) {
      const id = 990910300 + index;
      const lower = kind.toLowerCase();
      await query(`INSERT INTO ${header}(netsuite_id,tranid,status,netsuite_active) VALUES($1,$2,'B',true),($3,$4,'B',true)`, [id, `ORDERLINE-SRC-${kind}`, -id, `ORDERLINE-SPLIT-${kind}`]);
      await upsert(id, [line(17)]);
      const source = (await query(`SELECT id FROM ${table} WHERE ${parent}=$1`, [id])).rows[0];
      const split = await query(`INSERT INTO dispatch_scm_${lower}_splits(source_${lower}_id,source_${lower}_ref,split_${lower}_id,split_${lower}_ref,status)
        VALUES($1,$2,$3,$4,'active') RETURNING id`, [id, `ORDERLINE-SRC-${kind}`, -id, `ORDERLINE-SPLIT-${kind}`]);
      const child = await query(`INSERT INTO ${table}(${parent},line_id,item_id,netsuite_active${kind === "TO" ? ",line_stage" : ""})
        VALUES($1,$2,$3,true${kind === "TO" ? ",'outbound'" : ""}) RETURNING id`, [-id, kind === "SO" ? line().line_id : -line().line_id, line().item_id]);
      if (kind !== "SO") {
        await query(`INSERT INTO dispatch_scm_${lower}_split_lines(split_id,source_line_id,split_line_id) VALUES($1,$2,$3)`,
          [split.rows[0].id, source.id, child.rows[0].id]);
      }
      const readChild = async () => (await query(`SELECT netsuite_order_line FROM ${table} WHERE id=$1`, [child.rows[0].id])).rows[0].netsuite_order_line;
      assert.equal(Number(await readChild()), 17, `${kind} child inherits the source mapping`);
      await upsert(id, [line(23)]);
      assert.equal(Number(await readChild()), 23, `${kind} source refresh reaches its exact child`);
    }
  }, { rollback: true });
});

test("actual SuiteQL readers retain source orderLine and isolate each transfer stage", async () => {
  const previous = { ...config.netsuite }, nativeFetch = globalThis.fetch;
  try {
    config.netsuite.directAccessEnabled = true;
    config.netsuite.restBaseUrl = "https://netsuite.invalid/services/rest";
    await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'orderline-fixture',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
    let returned = [{ id: 990930000, transaction_id: 990930000, line_id: 810001, item_id: 42, netsuite_order_line: 17,
      order_line: 17, quantity: -5, unit: "EACH", location_id: 1, item_type: "InvtPart", to_pcs: 1 }];
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, "https://netsuite.invalid");
      assert.equal(new URL(url).pathname, "/services/rest/query/v1/suiteql");
      const sql = JSON.parse(options.body).q;
      assert.match(sql, /tl\.id AS (?:netsuite_order_line|order_line_number)/u);
      return new Response(JSON.stringify({ items: returned, hasMore: false }), { status: 200 });
    };
    assert.equal((await fetchDeliveryOrderDetailsFromNetSuite(990930000))[0].netsuite_order_line, 17);
    assert.equal((await fetchDeliveryOrderDetailsBatchFromNetSuite([990930000])).get(990930000)[0].netsuite_order_line, 17);
    assert.equal((await fetchPurchaseOrderDetailsFromNetSuite(990930000))[0].netsuite_order_line, 17);
    returned = [1, 2, 3, 4, 5, 6].map(n => ({ id: 990930000, record_type: "TrnfrOrd", tranid: "TOB-FIXTURE",
      line_id: 810000 + n, source_line_key: String(810000 + n), item_id: 42, item_type: "InvtPart",
      order_line_number: n, line_sequence_number: n, do_not_print_line: [1, 4].includes(n) ? "F" : "T",
      quantity: n % 3 === 0 ? 5 : -5, signed_quantity: n % 3 === 0 ? 5 : -5, ordered_quantity: 5,
      location_id: n % 3 === 0 ? 28 : 1, line_location_id: n % 3 === 0 ? 28 : 1, unit: "EACH", to_pcs: 1 }));
    const outbound = await fetchTransferOrderDetailsFromNetSuite(990930000, 1);
    const receiving = await fetchTransferOrderDetailsFromNetSuite(990930000, 28, { direction: "destination" });
    assert.deepEqual(outbound.map(row => [row.location_id, row.netsuite_order_line]), [[1, 1], [1, 4]]);
    assert.deepEqual(receiving.map(row => [row.location_id, row.netsuite_order_line]), [[28, 1], [28, 4]]);
    const progress = await fetchTransactionProgressFromNetSuite(990930000, "TrnfrOrd");
    assert.deepEqual(progress.lines.map(row => row.netsuite_order_line), [1, 1, 1, 4, 4, 4]);
    const reconciled = await fetchScmReconciliationOrdersFromNetSuite({ kind: "TO", orderIds: [990930000], targetOnly: true });
    assert.deepEqual(reconciled[0].lines.map(row => row.netsuite_order_line), [1, 4, 1, 4]);
  } finally {
    globalThis.fetch = nativeFetch;
    Object.assign(config.netsuite, previous);
  }
});

test("SCM reconciliation persists mappings from exact and legacy progress readers", async () => {
  const previous = { ...config.netsuite }, nativeFetch = globalThis.fetch;
  try {
    config.netsuite.directAccessEnabled = true;
    config.netsuite.restBaseUrl = "https://netsuite.invalid/services/rest";
    for (const fallback of [false, true]) {
      await withTransaction(async () => {
        const id = 990940000;
        await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,status_text,netsuite_active) VALUES($1,'POB-ORDERLINE-SCM','B','Pending Receipt',true)", [id]);
        await query("UPDATE scm_reconciliation_settings SET initial_dry_run_approved_at=now(),initial_dry_run_approved_by='orderline-fixture'");
        globalThis.fetch = async (url, options) => {
          assert.equal(new URL(url).origin, "https://netsuite.invalid");
          const sql = JSON.parse(options.body).q;
          const row = { id, tranid: "POB-ORDERLINE-SCM", record_type: "PurchOrd", status: "B", status_text: "Pending Receipt",
            line_id: 991940001, source_line_key: "991940001", order_line_number: 17, netsuite_order_line: 17,
            item_id: 42, item_name: "ORDERLINE-SCM", item_type: "InvtPart", quantity: 10, signed_quantity: 10,
            ordered_quantity: 10, cumulative_progress_quantity: 0, unit: "EACH", to_pcs: 1, location_id: 1, line_location_id: 1 };
          let items = [];
          if (sql.includes("AS source_line_key") && !fallback) {items = [row];}
          if (sql.includes("AS netsuite_order_line")) {items = [row];}
          return new Response(JSON.stringify({ items, hasMore: false }), { status: 200 });
        };
        const run = await startScmReconciliationRun({ scope: "order_family", targetOrderKind: "PO", targetOrderId: id,
          targetOrderRef: "POB-ORDERLINE-SCM", dryRun: false, applyUnambiguous: true, requestedBy: "orderline-fixture" });
        assert.ok(["succeeded", "completed"].includes(run.status), JSON.stringify(run));
        const saved = (await query("SELECT line_id,netsuite_order_line FROM purchase_order_lines WHERE purchase_order_id=$1", [id])).rows;
        assert.deepEqual(saved.map(row => [Number(row.line_id), Number(row.netsuite_order_line)]), [[991940001, 17]]);
      }, { rollback: true });
    }
  } finally {
    globalThis.fetch = nativeFetch;
    Object.assign(config.netsuite, previous);
  }
});

test("PO history refresh stores the REST line alongside its stable unique key", async () => {
  const previous = { ...config.netsuite }, nativeFetch = globalThis.fetch;
  try {
    config.netsuite.directAccessEnabled = true;
    config.netsuite.restBaseUrl = "https://netsuite.invalid/services/rest";
    await withTransaction(async () => {
      const id = 990940100;
      await query("INSERT INTO purchase_orders(netsuite_id,tranid,status,netsuite_active) VALUES($1,'POB-ORDERLINE-HISTORY','B',true)", [id]);
      const history = await query("INSERT INTO scm_netsuite_po_history(netsuite_purchase_order_id,netsuite_purchase_order_ref) VALUES($1,'POB-ORDERLINE-HISTORY') RETURNING id", [id]);
      globalThis.fetch = async (url, options) => {
        assert.equal(new URL(url).origin, "https://netsuite.invalid");
        assert.match(JSON.parse(options.body).q, /rest_line_id/u);
        return new Response(JSON.stringify({ hasMore: false, items: [{ id, tranid: "POB-ORDERLINE-HISTORY", status: "B", status_text: "Pending Receipt",
          line_id: 991940101, rest_line_id: 4, item_id: 42, item_name: "ORDERLINE-HISTORY", item_type: "InvtPart", quantity: 10, unit: "EACH", to_pcs: 1 }] }), { status: 200 });
      };
      await refreshScmNetSuitePoHistory(Number(history.rows[0].id));
      const saved = (await query("SELECT line_id,netsuite_order_line FROM purchase_order_lines WHERE purchase_order_id=$1", [id])).rows;
      assert.deepEqual(saved.map(row => [Number(row.line_id), Number(row.netsuite_order_line)]), [[991940101, 4]]);
    }, { rollback: true });
  } finally {
    globalThis.fetch = nativeFetch;
    Object.assign(config.netsuite, previous);
  }
});
