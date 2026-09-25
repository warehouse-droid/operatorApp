import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { config } from "../../../src/config.js";
import { saveReturnDraft, submitReturnBatch, listReturnDrafts } from "../../../src/return-repository.js";

after(closeDb);
let sequence = 0;

async function fixture(t, { physical = false, rate = 12.5 } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assert.match(process.env.DATABASE_URL, /\/mbt_test(?:_file_[a-f0-9]{12}_[a-z0-9]+)?(?:[?#]|$)/);
  const actor = crypto.randomUUID();
  const orderId = 99180000 + ++sequence;
  const sourceLineId = orderId + 10000;
  const itemId = 99189901;
  const photo = `r2://operator/operator-return-photo/2026/09/18/${actor}/test/photo.jpg`;
  const previous = { direct: config.netsuite.directAccessEnabled, rest: config.netsuite.restBaseUrl,
    photo: { ...config.photoUpload } };
  config.netsuite.directAccessEnabled = true;
  config.netsuite.restBaseUrl = "https://stock-return-test.invalid/services/rest";
  config.photoUpload.workerUrl = "https://stock-return-photo.invalid";
  config.photoUpload.tokenSecret = "stock-return-synthetic-photo-key";
  t.after(() => {
    config.netsuite.directAccessEnabled = previous.direct;
    config.netsuite.restBaseUrl = previous.rest;
    Object.assign(config.photoUpload, previous.photo);
  });
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids)
    VALUES($1,$1,'Stock return test','test','test','admin',ARRAY['admin'],ARRAY[1])`, [actor]);
  t.after(async () => {
    await query("DELETE FROM return_records WHERE operator_id=$1", [actor]);
    await query("DELETE FROM return_batches WHERE operator_id=$1", [actor]);
    await query("DELETE FROM return_drafts WHERE operator_id=$1", [actor]);
  });
  await query(`INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'fixture',now()+interval '1 hour')
    ON CONFLICT(id) DO UPDATE SET access_token='fixture',expires_at=EXCLUDED.expires_at`);
  await query(`INSERT INTO inventory_items(item_id,item_name,product_type,return_policy_override)
    VALUES($1,'STOCK RETURN TEST','Natural Stone','ALLOWED')
    ON CONFLICT(item_id) DO UPDATE SET product_type='Natural Stone',return_policy_override='ALLOWED'`, [itemId]);
  const remoteLine = { id: String(orderId), tranid: `SOB${orderId}`, status: "G", status_text: "Billed",
    customer_id: "99189902", customer_name: "Synthetic return customer", ordering_location_id: "1",
    line_id: String(sourceLineId), suiteql_line_number: "2", item_id: String(itemId),
    item_name: "STOCK RETURN TEST", item_description: "Distinct source description", item_type: "InvtPart",
    sales_quantity: 1000, fulfilled_quantity: 1000, sales_uom: "Each", sales_uom_id: 3,
    rate, line_location_id: 1, ...(physical ? { to_plt: 100, to_lyr: 10, to_sec: 5, to_pcs: 1 } : {}) };
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith(config.photoUpload.workerUrl)) {
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });
    }
    if (address.includes("/query/")) {
      const sql = JSON.parse(options.body).q;
      let items = [];
      if (sql.includes("AS sales_quantity")) { items = [remoteLine]; }
      else if (sql.includes("'ItemShip' AS transaction_type")) {
        items = [{ transaction_type: "ItemShip", quantity: 20, transaction_count: 1 }];
      } else if (/FROM item\b/.test(sql) && /PALLET/.test(sql)) {
        items = [{ id: "99189904", itemid: "PALLET", itemtype: "NonInvtPart" }];
      }
      return Response.json({ items, hasMore: false });
    }
    if (address.includes("/salesOrder/") && options.method === "GET") {
      return Response.json({ item: { items: [{ orderLine: 2, item: { id: String(itemId) }, quantity: 1000, location: { id: "1" } }] } });
    }
    writes.push({ address, method: options.method });
    throw new Error(`Unexpected external request: ${options.method} ${address}`);
  });
  const input = { idempotencyKey: crypto.randomUUID(), receivingLocationId: 1, orderId,
    vehiclePlate: "TEST 123", stockReturnType: "normal", note: "Batch note", photos: [photo],
    lines: [{ sourceLineId, note: "Line note", ...(physical
      ? { pallets: 1, layers: 2, sections: 3, pieces: 4 } : { salesQuantity: 2.375 }) }] };
  return { actor, sourceLineId, itemId, photo, input, writes };
}

async function save(f) {
  const draft = await saveReturnDraft({ operatorId: f.actor, input: f.input });
  return { ...draft.payload, draftId: draft.id };
}

async function submit(f, input) {
  return submitReturnBatch({ operatorId: f.actor, input, autoSync: false });
}

async function storedLines(recordId) {
  return (await query("SELECT * FROM return_record_lines WHERE return_record_id=$1 ORDER BY id", [recordId])).rows;
}

test("normal stock draft preserves every line field and consumes the draft only on success", async t => {
  const f = await fixture(t, { physical: true });
  const input = await save(f);
  const result = await submit(f, input);
  assert.equal(result.records.length, 1);
  const [line] = await storedLines(result.stockReturn.id);
  const fields = ["source_sales_order_line_id", "netsuite_order_line_id", "source_local_line_id", "item_id",
    "item_name", "item_description", "item_type", "sales_uom", "sales_order_quantity", "fulfilled_quantity",
    "netsuite_returned_quantity", "local_reserved_quantity", "returned_sales_quantity", "returned_pallets",
    "returned_layers", "returned_sections", "returned_pieces", "to_plt", "to_lyr", "to_sec", "to_pcs",
    "entry_mode", "return_policy_default", "return_policy_override", "return_policy_effective",
    "approval_status", "reason_id", "reason_code", "reason_label", "note", "rate", "estimated_credit"];
  const expected = [f.sourceLineId, 2, null, f.itemId, "STOCK RETURN TEST", "Distinct source description", "InvtPart",
    "Each", 1000, 1000, 0, 0, 139, 1, 2, 3, 4, 100, 10, 5, 1, "physical_units", "APPROVAL_REQUIRED", "ALLOWED",
    "ALLOWED", "not_required", 10, "GD", "GD - Good Condition", "Line note", 12.5, 1737.5];
  assert.deepEqual(fields.map((field, i) => typeof expected[i] === "number" ? Number(line[field]) : line[field]), expected);
  assert.equal(line.source_line_snapshot.sourceLineId, f.sourceLineId);
  assert.equal(line.source_line_snapshot.rate, 12.5);
  assert.equal(line.source_line_snapshot.itemId, f.itemId);
  assert.deepEqual(line.netsuite_line_snapshot.returnTransactions, []);
  assert.equal(line.netsuite_line_snapshot.lookedUpAt, line.source_line_snapshot.lookedUpAt ?? result.stockReturn.balanceSnapshot.lookedUpAt);
  assert.deepEqual(await listReturnDrafts({ operatorId: f.actor }), []);
  const photos = await query("SELECT photo_kind,photo_reference FROM return_photos WHERE return_record_id=$1", [result.stockReturn.id]);
  assert.deepEqual(photos.rows, [{ photo_kind: "stock", photo_reference: f.photo }]);
  const replay = await submit(f, input);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.stockReturn.id, result.stockReturn.id);
  assert.equal((await storedLines(result.stockReturn.id)).length, 1);
  assert.equal((await query("SELECT id FROM return_batches WHERE operator_id=$1", [f.actor])).rowCount, 1);
  assert.deepEqual(f.writes, []);
});

test("quality stock draft keeps separate reasons on the same source line with PALLET return", async t => {
  const f = await fixture(t);
  f.input.stockReturnType = "quality";
  f.input.lines = [
    { sourceLineId: f.sourceLineId, salesQuantity: 1.25, reasonId: 5, note: "Color", photos: [f.photo] },
    { sourceLineId: f.sourceLineId, salesQuantity: 2.5, reasonId: 7, note: "Crack", photos: [f.photo] }
  ];
  Object.assign(f.input, { palletQuantity: 3, palletPhotos: [f.photo] });
  const input = await save(f);
  const result = await submit(f, input);
  assert.equal(result.records.length, 2);
  const lines = await storedLines(result.stockReturn.id);
  assert.deepEqual(lines.map(line => [Number(line.source_sales_order_line_id), Number(line.returned_sales_quantity),
    Number(line.reason_id), line.reason_code, line.note, Number(line.estimated_credit)]), [
    [f.sourceLineId, 1.25, 5, "R1", "Color", 15.63], [f.sourceLineId, 2.5, 7, "R3", "Crack", 31.25]
  ]);
  assert.equal(Number(result.palletReturn.palletQuantity), 3);
  assert.equal(Number(result.palletReturn.estimatedCredit), 120);
  assert.deepEqual(await listReturnDrafts({ operatorId: f.actor }), []);
  const photos = await query("SELECT photo_kind,return_line_id FROM return_photos WHERE return_record_id=ANY($1::bigint[])",
    [result.records.map(record => record.id)]);
  assert.equal(photos.rows.filter(row => row.return_line_id !== null).length, 2);
  assert.equal(photos.rows.filter(row => row.photo_kind === "pallet").length, 1);
  const replay = await submit(f, input);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.records.map(record => record.id).sort(), result.records.map(record => record.id).sort());
  assert.deepEqual(f.writes, []);
});

test("failure on the second stock line rolls back the entire batch and retains a retryable draft", async t => {
  const f = await fixture(t);
  f.input.lines.push({ sourceLineId: f.sourceLineId, salesQuantity: 1, note: "force SQL failure" });
  const input = await save(f);
  const before = await listReturnDrafts({ operatorId: f.actor });
  await query("ALTER TABLE return_record_lines ADD CONSTRAINT stock_return_fixture_failure CHECK (note <> 'force SQL failure') NOT VALID");
  t.after(() => query("ALTER TABLE return_record_lines DROP CONSTRAINT IF EXISTS stock_return_fixture_failure"));
  await assert.rejects(submit(f, input), { code: "23514", constraint: "stock_return_fixture_failure" });
  assert.deepEqual(await listReturnDrafts({ operatorId: f.actor }), before);
  assert.equal((await query("SELECT id FROM return_batches WHERE operator_id=$1", [f.actor])).rowCount, 0);
  assert.equal((await query("SELECT id FROM return_records WHERE operator_id=$1", [f.actor])).rowCount, 0);
  assert.equal((await query("SELECT id FROM return_record_lines WHERE source_sales_order_line_id=$1", [f.sourceLineId])).rowCount, 0);
  await query("ALTER TABLE return_record_lines DROP CONSTRAINT stock_return_fixture_failure");
  const result = await submit(f, input);
  assert.equal((await storedLines(result.stockReturn.id)).length, 2);
  assert.deepEqual(await listReturnDrafts({ operatorId: f.actor }), []);
});

test("invalid and excess stock quantities preserve the saved draft", async t => {
  const f = await fixture(t);
  const input = await save(f);
  const before = await listReturnDrafts({ operatorId: f.actor });
  for (const quantity of [-1, 0, 1001, "NaN", "1); DROP TABLE return_drafts; --"]) {
    await assert.rejects(submit(f, { ...input, lines: [{ sourceLineId: f.sourceLineId, salesQuantity: quantity }] }));
    assert.deepEqual(await listReturnDrafts({ operatorId: f.actor }), before);
  }
  assert.equal((await query("SELECT id FROM return_batches WHERE operator_id=$1", [f.actor])).rowCount, 0);
});

test("generated fractional quantities and rates round-trip without shifted columns or lost precision", async t => {
  let state = 91826;
  const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  for (let i = 0; i < 24; i += 1) {
    const rate = (random(10000) + 1) / 100;
    const quantity = (random(10000) + 1) / 1000;
    const f = await fixture(t, { rate });
    f.input.lines[0].salesQuantity = quantity;
    const result = await submit(f, await save(f));
    const [line] = await storedLines(result.stockReturn.id);
    assert.equal(Number(line.returned_sales_quantity), quantity);
    assert.equal(Number(line.rate), rate);
    assert.equal(Number(line.estimated_credit), Math.round(quantity * rate * 100) / 100);
    assert.equal(line.source_line_snapshot.rate, rate);
    assert.equal(line.source_line_snapshot.sourceLineId, f.sourceLineId);
    assert.deepEqual(line.netsuite_line_snapshot.returnTransactions, []);
    assert.deepEqual(f.writes, []);
  }
});
