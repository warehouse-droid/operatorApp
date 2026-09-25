import assert from "node:assert/strict";
import test, { after } from "node:test";
import http from "node:http";
import { query, closeDb, withTransaction } from "../../../src/db.js";
import { config } from "../../../src/config.js";
import { submitReturnBatch, syncReturnRecord, getReturnRecordDetail, localPalletReserved,
  processPendingReturnSyncs, decideReturnLine, voidReturnRecord, linkReturnNetSuiteTransaction,
  reconcileReturnRecords } from "../../../src/return-repository.js";
import { updateMbtFeatureFlagState, listMbtAdminFeatureFlags } from "../../../src/mbt/feature-flag-repository.js";
import { getOperatorNetSuitePostingPolicy } from "../../../src/operator-netsuite-posting-policy-repository.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { app } from "../../../src/server.js";

after(closeDb);
const actor = "return-ra-test";
let sequence = 0;
const reasonPhotos = [`r2://operator/operator-return-photo/2026/09/17/${actor}/test/photo.jpg`];

function fixtureRows(sql, remoteLines, created, control) {
      let items = [];
      if (sql.includes("AS sales_quantity")) {items = remoteLines;}
      else if (sql.includes("t.externalid =")) {
        const match = sql.match(/t.externalid = '([^']+)'/);
        items = control.hideExternalId ? [] : [...created.values()].filter(s => s.externalId === match?.[1]).map(s => ({ id: s.id, tranid: s.tranId }));
      } else if (sql.includes("return_ra_credit_lines")) {items = control.credits;}
      else if (sql.includes("'ItemShip' AS transaction_type")) {
        items = [{ transaction_type: "ItemShip", quantity: 20, transaction_count: 1 },
          ...control.credits.map(c => ({ transaction_type: "CustCred", transaction_id: c.transaction_id, quantity: c.quantity }))];
      } else if (/FROM item\b/.test(sql) && /PALLET/.test(sql)) {items = [{ id: "99091704", itemid: "PALLET", itemtype: "NonInvtPart" }];}
      else if (/FROM customer c/.test(sql)) {items = [{ id: "99091702", entityid: "TEST", companyname: "Return test" }];}
  return control.duplicateExternalIds && sql.includes("t.externalid =") ? [{ id: 44 }, { id: 45 }] : items;
}

async function fixtureCreate(address, body, created, control) {
      if (control.onCreate) {await control.onCreate();}
      if (control.rejectCreate) {return Response.json({ "o:errorDetails": [{ "o:errorCode": "INVALID_QUANTITY", detail: "Invalid quantity" }] }, { status: 400 });}
      const id = String(99092000 + ++sequence);
      const data = { ...body, id, tranId: `RA${id}`, entity: { id: "99091702" }, status: { refName: "Pending Receipt" },
        ...(address.includes("!transform") ? { createdFrom: { id: "99091700" } } : {}) };
      data.item.items = data.item.items.map((line, index) => ({ ...line, line: index + 1 }));
      created.set(id, data);
      if (control.alter) {control.alter(data);}
      if (control.failAfterCreate) {throw new Error("connection lost after create");}
      return new Response(null, { status: 204, headers: control.omitLocation ? {} : { location: `https://return-ra.invalid/record/v1/returnAuthorization/${id}` } });
}

async function fixture(t, { enabled = true } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const flags = await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  t.after(async () => {
    for (const flag of flags.rows) {
      await query("UPDATE mbt_feature_flags SET enabled=$2,revision=$3 WHERE flag_key=$1", [flag.flag_key, flag.enabled, flag.revision]);
    }
  });
  const previous = { direct: config.netsuite.directAccessEnabled, url: config.netsuite.restBaseUrl, photo: { ...config.photoUpload } };
  config.netsuite.directAccessEnabled = true;
  config.netsuite.restBaseUrl = "https://return-ra.invalid/services/rest";
  config.photoUpload.workerUrl = "https://photo.return-ra.invalid";
  config.photoUpload.tokenSecret = "test-return-photo-key";
  t.after(() => { config.netsuite.directAccessEnabled = previous.direct; config.netsuite.restBaseUrl = previous.url;
    Object.assign(config.photoUpload, previous.photo); });
  await query("DELETE FROM return_batch_authorizations WHERE intent_snapshot->>'customerId'='99091702'");
  await query("DELETE FROM return_records WHERE operator_id=$1 OR customer_id=99091702", [actor]);
  await query("DELETE FROM return_batches WHERE operator_id=$1", [actor]);
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids)
    VALUES($1,$1,'RA test','test','test','admin',ARRAY['admin'],ARRAY[1,28]) ON CONFLICT(id) DO NOTHING`, [actor]);
  await query(`INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'fixture',now()+interval '1 hour')
    ON CONFLICT(id) DO UPDATE SET access_token='fixture',expires_at=EXCLUDED.expires_at`);
  await query(`INSERT INTO inventory_items(item_id,item_name,product_type) VALUES(99091701,'RA ITEM','Natural Stone')
    ON CONFLICT(item_id) DO UPDATE SET product_type='Natural Stone',return_policy_override=NULL`);
  await query(`UPDATE mbt_feature_flags SET enabled=$1,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'`, [enabled]);
  const requests = [];
  const created = new Map();
  const control = { failAfterCreate: false, alter: null, credits: [], onCreate: null, rejectCreate: false, hideExternalId: false };
  const remoteLines = [
    { id: "99091700", tranid: "SOB99091700", status: "G", status_text: "Billed", customer_id: "99091702",
      customer_name: "Return test", ordering_location_id: "1", line_id: "99091703", suiteql_line_number: "2",
      item_id: "99091701", item_name: "RA ITEM", item_type: "InvtPart", sales_quantity: 10,
      fulfilled_quantity: 10, sales_uom: "Each", sales_uom_id: 3, rate: 12.5, line_location_id: 1 }
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith("https://photo.return-ra.invalid")) {return new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } });}
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ address, method: options.method, body });
    if (address.includes("/query/")) {
      const items = fixtureRows(body.q, remoteLines, created, control);
      return Response.json({ items, hasMore: false });
    }
    if (address.includes("/salesOrder/") && options.method === "GET") {
      return Response.json({ item: { items: [{ orderLine: 2, item: { id: "99091701" }, quantity: 10, location: { id: "1" } }] } });
    }
    if (/(?:returnAuthorization|creditMemo)(?:\?|$)/i.test(address) && options.method === "POST") {
      return fixtureCreate(address, body, created, control);
    }
    if (/(?:returnAuthorization|creditMemo)\/\d+/i.test(address)) {
      const id = address.match(/(?:returnAuthorization|creditMemo)\/(\d+)/i)[1];
      return Response.json(created.get(id));
    }
    throw new Error(`Unexpected network request ${options.method} ${address}`);
  });
  return { requests, created, control, fetchMock, remoteLines };
}

async function seededRecord(kind, { version = 2, enabled = true, pendingApproval = false } = {}) {
  const suffix = ++sequence;
  const details = {
    stock: { stockType: "quality", orderId: 99091700, orderRef: "SOB99091700", quantity: null },
    pallet: { stockType: null, orderId: null, orderRef: null, quantity: 10 }
  }[kind];
  const batch = (await query(`INSERT INTO return_batches(batch_reference,idempotency_key,operator_id,receiving_location_id,
    receiving_yard_code,vehicle_plate) VALUES($1,$1,$2,1,'3445','TEST') RETURNING id`, [`RA-TEST-${suffix}`, actor])).rows[0];
  const policy = await getOperatorNetSuitePostingPolicy({ functionKey: `${kind}_return`, locationId: 1 });
  const record = (await query(`INSERT INTO return_records(record_reference,batch_id,record_type,stock_return_type,status,operator_id,
    source_sales_order_id,source_sales_order_ref,customer_id,customer_name,receiving_location_id,receiving_location_name,vehicle_plate,
    external_id,pallet_quantity,balance_snapshot,netsuite_sync_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,99091702,'Return test',1,'3445','TEST',$9,$10,$11::jsonb,$12) RETURNING id`,
  [`RA-RECORD-${suffix}`, batch.id, kind, details.stockType, pendingApproval ? "pending_approval" : "accepted", actor,
    details.orderId, details.orderRef, `MBBS-RA-TEST-${suffix}`,
    details.quantity, JSON.stringify({ item: { id: 99091704 } }), enabled ? "pending" : "disabled"])).rows[0];
  if (version === 2) {
    await query("UPDATE return_records SET workflow_version=2,netsuite_posting_policy=$2::jsonb WHERE id=$1", [record.id, JSON.stringify(policy)]);
  }
  if (kind === "stock") {
    for (const [qty, reasonId] of [[2, 5], [3, 7]]) {
      await query(`INSERT INTO return_record_lines(return_record_id,source_sales_order_line_id,netsuite_order_line_id,item_id,item_name,
        sales_uom,sales_order_quantity,fulfilled_quantity,returned_sales_quantity,entry_mode,return_policy_default,return_policy_effective,
        approval_status,reason_id,reason_code,reason_label,rate)
        VALUES($1,99091703,2,99091701,'RA ITEM','Each',10,10,$2,'sales_uom','APPROVAL_REQUIRED','ALLOWED',$3,$4,$5,$5,12.5)`,
      [record.id, qty, pendingApproval ? "pending" : "not_required", reasonId, `R${reasonId - 4}`]);
    }
  }
  return Number(record.id);
}

test("schema installs eight disabled RA gates and leaves legacy records on version one", async () => {
  const columns = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='return_records'
    AND column_name IN ('workflow_version','netsuite_posting_policy','netsuite_ra_attempted_at')`);
  assert.equal(columns.rowCount, 3);
  const gates = await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  assert.equal(gates.rowCount, 8);
  assert.ok(gates.rows.every(r => r.enabled === false));
});

test("R1 stock RA keeps split reason rows and recovers the same transaction on retry", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("stock");
  const result = await syncReturnRecord({ recordId: id });
  assert.equal(result.netSuiteStage, "return_authorization");
  assert.equal(result.netSuiteSyncStatus, "succeeded");
  const posted = [...remote.created.values()][0];
  assert.deepEqual(posted.item.items.map(l => [l.orderLine, l.quantity, l.custcol_atlas_rc_so.id]), [[2, 2, "5"], [2, 3, "7"]]);
  await Promise.all([syncReturnRecord({ recordId: id }), syncReturnRecord({ recordId: id })]);
  assert.equal(remote.created.size, 1);
});

test("R2 pallet posts RA instead of Credit Memo and accepted work survives a gate toggle", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  await query("UPDATE mbt_feature_flags SET enabled=false WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  const result = await syncReturnRecord({ recordId: id });
  assert.equal(result.netSuiteStage, "return_authorization");
  assert.equal(result.actualCredit, null);
  assert.equal([...remote.created.values()][0].item.items[0].rate, 40);
  assert.equal(remote.requests.some(r => r.address.includes("creditMemo")), false);
});

test("D1 a lost create response and simultaneous retries recover one RA", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("stock");
  remote.control.failAfterCreate = true;
  await assert.rejects(syncReturnRecord({ recordId: id }), /connection lost/);
  const results = await Promise.all([syncReturnRecord({ recordId: id }), syncReturnRecord({ recordId: id })]);
  assert.ok(results.every(r => r.netSuiteSyncStatus === "succeeded"));
  assert.equal(remote.created.size, 1);
});

test("R3 mismatched RA rows persist the remote ID and never create another RA", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("stock");
  remote.control.alter = data => { data.item.items.pop(); };
  await assert.rejects(syncReturnRecord({ recordId: id }), { code: "RETURN_RA_VERIFICATION_FAILED" });
  const failed = await getReturnRecordDetail(id);
  assert.ok(failed.netSuiteTransactionId);
  await assert.rejects(syncReturnRecord({ recordId: id }), { code: "RETURN_RA_VERIFICATION_FAILED" });
  assert.equal(remote.created.size, 1);
});

test("G2 local-only new records cannot be forced through a disabled gate or auto-posted later", async t => {
  const remote = await fixture(t, { enabled: false });
  const id = await seededRecord("pallet", { enabled: false });
  await assert.rejects(syncReturnRecord({ recordId: id, force: true }), /not admitted|disabled/i);
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  await processPendingReturnSyncs();
  assert.equal((await getReturnRecordDetail(id)).netSuiteStage, "local");
  assert.equal(remote.created.size, 0);
});

test("V1 legacy pending approval still blocks posting", async t => {
  await fixture(t);
  const id = await seededRecord("stock", { version: 1, pendingApproval: true });
  await assert.rejects(syncReturnRecord({ recordId: id, force: true }), /approval decision/);
  assert.equal((await getReturnRecordDetail(id)).workflowVersion, 1);
});

test("V1 new stock confirmation has no pending approval; stale policy fails before records are saved", async t => {
  await fixture(t);
  const policy = await getOperatorNetSuitePostingPolicy({ functionKey: "stock_return", locationId: 1 });
  const input = { idempotencyKey: `ra-submit-${++sequence}`, receivingLocationId: 1, orderId: 99091700,
    vehiclePlate: "TEST", stockReturnType: "normal", photos: reasonPhotos,
    lines: [{ sourceLineId: 99091703, salesQuantity: 1 }], expectedPostingPolicies: { stock_return: { ...policy, revision: policy.revision - 1 } } };
  await assert.rejects(submitReturnBatch({ operatorId: actor, input, autoSync: false }),
    { code: "OPERATOR_NETSUITE_POSTING_POLICY_CHANGED" });
  assert.equal((await query("SELECT id FROM return_batches WHERE idempotency_key=$1", [`client:${actor}:${input.idempotencyKey}`])).rowCount, 0);
});

async function submitInput({ pallet = false, stock = true, quantity = 1 } = {}) {
  const policies = {};
  for (const kind of [stock && "stock_return", pallet && "pallet_return"].filter(Boolean)) {
    policies[kind] = await getOperatorNetSuitePostingPolicy({ functionKey: kind, locationId: 1 });
  }
  return { idempotencyKey: `ra-submit-${++sequence}`, receivingLocationId: 1,
    ...(stock ? { orderId: 99091700, stockReturnType: "normal", photos: reasonPhotos,
      lines: [{ sourceLineId: 99091703, salesQuantity: quantity }] } : { customerId: 99091702 }),
    vehiclePlate: "TEST", palletQuantity: pallet ? quantity : 0, palletPhotos: pallet ? reasonPhotos : [],
    expectedPostingPolicies: policies };
}

test("V1/R1/R2 combined confirmation immediately creates one verified RA without a local approval step", async t => {
  const remote = await fixture(t);
  const input = await submitInput({ pallet: true });
  const result = await submitReturnBatch({ operatorId: actor, input });
  assert.equal(result.records.length, 2);
  assert.equal(remote.created.size, 1);
  assert.ok(result.records.every(r => r.workflowVersion === 3 && r.status === "accepted" && r.netSuiteSyncStatus === "succeeded"));
  assert.ok(result.stockReturn.lines.every(l => l.approvalStatus === "not_required"));
  assert.equal([...remote.created.values()].find(s => s.createdFrom).item.items[0].units.id, "3");
  assert.equal((await submitReturnBatch({ operatorId: actor, input })).idempotentReplay, true);
  assert.equal(remote.created.size, 1);
  await assert.rejects(decideReturnLine({ recordId: result.stockReturn.id, lineId: result.stockReturn.lines[0].id,
    decision: "approved", actorOperatorId: actor }), /do not require local approval/);
});

test("G2 gate-off saves locally; missing policy cannot post; an unrelated yard token cannot admit", async t => {
  const remote = await fixture(t, { enabled: false });
  const local = await submitReturnBatch({ operatorId: actor, input: await submitInput() });
  assert.equal(local.stockReturn.netSuiteSyncStatus, "disabled");
  assert.equal(local.stockReturn.workflowVersion, 3);
  assert.equal(remote.created.size, 0);
  await query("UPDATE mbt_feature_flags SET enabled=true,revision=revision+1 WHERE flag_key LIKE 'operator_netsuite_%return_ra_%'");
  const input = await submitInput();
  input.expectedPostingPolicies = {};
  await assert.rejects(submitReturnBatch({ operatorId: actor, input }), { code: "OPERATOR_NETSUITE_POSTING_POLICY_CHANGED" });
  input.expectedPostingPolicies.stock_return = await getOperatorNetSuitePostingPolicy({ functionKey: "stock_return", locationId: 28 });
  await assert.rejects(submitReturnBatch({ operatorId: actor, input }), { code: "OPERATOR_NETSUITE_POSTING_POLICY_CHANGED" });
});

test("V1 confirmation still enforces NOT_RETURNABLE, evidence, stock quota and pallet quota", async t => {
  await fixture(t);
  const input = await submitInput();
  await query("UPDATE inventory_items SET return_policy_override='NOT_RETURNABLE' WHERE item_id=99091701");
  await assert.rejects(submitReturnBatch({ operatorId: actor, input }), /not eligible for this return/i);
  await query("UPDATE inventory_items SET return_policy_override=NULL WHERE item_id=99091701");
  await assert.rejects(submitReturnBatch({ operatorId: actor, input: { ...input, photos: [] } }), /photo/i);
  await assert.rejects(submitReturnBatch({ operatorId: actor, input: await submitInput({ quantity: 11 }) }), /exceeds.*returnable/i);
  await assert.rejects(submitReturnBatch({ operatorId: actor, input: await submitInput({ stock: false, pallet: true, quantity: 21 }) }), /Maximum.*PALLET/i);
});

test("D1 create intent and discovered ID survive rollback after NetSuite returns", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("stock");
  remote.control.onCreate = async () => assert.ok((await query("SELECT netsuite_ra_attempted_at FROM return_records WHERE id=$1", [id])).rows[0].netsuite_ra_attempted_at);
  await assert.rejects(withTransaction(async () => {
    await syncReturnRecord({ recordId: id });
    throw new Error("simulated local rollback");
  }), /simulated local rollback/);
  const saved = await getReturnRecordDetail(id);
  assert.ok(saved.netSuiteTransactionId);
  assert.ok(saved.netSuiteRaAttemptedAt);
  assert.equal((await syncReturnRecord({ recordId: id })).netSuiteSyncStatus, "succeeded");
  assert.equal(remote.created.size, 1);
});

test("D1 an unconfirmed RA cannot be recreated or voided while the external-ID lookup is empty", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  remote.control.failAfterCreate = true;
  await assert.rejects(syncReturnRecord({ recordId: id }), /connection lost/);
  remote.control.hideExternalId = true;
  await assert.rejects(syncReturnRecord({ recordId: id }), { code: "RETURN_RA_CREATION_UNCERTAIN" });
  await assert.rejects(voidReturnRecord({ recordId: id, actorOperatorId: actor, reason: "test" }), /unconfirmed|uncertain/i);
  assert.equal(remote.created.size, 1);
  assert.equal(await localPalletReserved(99091702), 10);
});

test("D1 a definite validation rejection permits correction/retry, but the global ceiling still blocks", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  remote.control.rejectCreate = true;
  await assert.rejects(syncReturnRecord({ recordId: id }), /NetSuite.*400/i);
  assert.equal((await getReturnRecordDetail(id)).netSuiteRaAttemptedAt, null);
  remote.control.rejectCreate = false;
  config.netsuite.directAccessEnabled = false;
  await assert.rejects(syncReturnRecord({ recordId: id }), /direct.*access.*disabled/i);
  assert.equal(remote.created.size, 0);
  config.netsuite.directAccessEnabled = true;
  assert.equal((await syncReturnRecord({ recordId: id })).netSuiteSyncStatus, "succeeded");
});

test("Q1 partial observed Credit Memos reduce the reservation without releasing the remaining RA quantity", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  const ra = await syncReturnRecord({ recordId: id });
  remote.control.credits = [{ return_authorization_id: ra.netSuiteTransactionId, transaction_id: 8801, quantity: 3 },
    { return_authorization_id: ra.netSuiteTransactionId, transaction_id: 8802, quantity: 2 }];
  const credits = remote.control.credits.map(c => ({ returnAuthorizationId: c.return_authorization_id, transactionId: c.transaction_id, quantity: c.quantity }));
  assert.equal(await localPalletReserved(99091702, [], [8801], credits), 7);
  assert.equal(await localPalletReserved(99091702, [], [8801, 8802], [...credits, credits[0]]), 5);
  // 20 fulfilled - 5 credited - 5 still reserved = 10 available.
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput({ stock: false, pallet: true, quantity: 10 }), autoSync: false });
  assert.equal(result.palletReturn.balanceSnapshot.available, 10);
  assert.equal(result.palletReturn.balanceSnapshot.localReserved, 5);
});

test("HTTP confirmed stock return exposes verified RA references, rejects another yard, and preserves idempotency", async t => {
  const remote = await fixture(t);
  const username = `return-http-${process.pid}-${++sequence}`;
  const password = "synthetic-return-http-password";
  const operator = await createOperator({ username, displayName: "Return HTTP", password,
    role: "operator", roles: ["operator"], operatorYardLocationIds: [1] });
  const { token } = await loginOperator(username, password);
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (path, body) => new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: server.address().port, path,
      method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    request.on("error", reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
  const input = await submitInput();
  input.photos = [`r2://operator/operator-return-photo/2026/09/17/${operator.id}/test/photo.jpg`];
  const policy = await call("/api/operator/netsuite-posting-policy?functionKey=stock_return&locationId=1");
  assert.equal(policy.status, 200);
  assert.equal(policy.body.transactionType, "RA");
  input.expectedPostingPolicies.stock_return = policy.body;
  assert.equal((await call("/api/returns/submit", { ...input, receivingLocationId: 28 })).status, 403);
  const submitted = await call("/api/returns/submit", input);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.match(submitted.body.stockReturn.netSuiteTransactionRef, /^RA\d+$/);
  assert.equal(submitted.body.stockReturn.lines[0].rate, undefined);
  assert.equal(submitted.body.stockReturn.netSuiteSnapshot, undefined);
  assert.equal((await call("/api/returns/submit", input)).status, 200);
  assert.equal(remote.created.size, 1);
});

test("G1 Admin RA gates use the existing revision, replay and audit path", async t => {
  await fixture(t, { enabled: false });
  const flags = await listMbtAdminFeatureFlags();
  const flag = flags.find(f => f.flagKey === "operator_netsuite_stock_return_ra_3445");
  const command = { actor: { operatorId: actor, roles: ["admin"] }, flagKey: flag.flagKey,
    enabled: true, expectedRevision: flag.revision, reason: "isolated test",
    idempotencyKey: `return-gate-${process.pid}-${++sequence}`, correlationId: "return-gate", requestId: "return-gate" };
  assert.equal((await updateMbtFeatureFlagState(command)).status, 200);
  assert.equal((await updateMbtFeatureFlagState(command)).replayed, true);
  await assert.rejects(updateMbtFeatureFlagState({ ...command, enabled: false, idempotencyKey: `return-gate-${process.pid}-${++sequence}` }), { status: 409 });
  assert.equal((await getOperatorNetSuitePostingPolicy({ functionKey: "stock_return", locationId: 1 })).effective, true);
  assert.equal((await getOperatorNetSuitePostingPolicy({ functionKey: "pallet_return", locationId: 1 })).effective, false);
});

test("V1 legacy PALLET records keep direct Credit Memo posting", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet", { version: 1 });
  const result = await syncReturnRecord({ recordId: id, force: true });
  assert.equal(result.workflowVersion, 1);
  assert.equal(result.netSuiteStage, "credit_memo");
  assert.equal(remote.requests.filter(r => r.method === "POST" && /\/creditMemo$/.test(r.address)).length, 1);
  assert.equal(remote.requests.some(r => r.method === "POST" && r.address.includes("returnAuthorization")), false);
});

test("R3 manual linking and reconciliation verify new pallet RAs, including remote cancellation before void", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  const result = await syncReturnRecord({ recordId: id });
  const linked = await linkReturnNetSuiteTransaction({ recordId: id, transactionType: "return_authorization",
    netsuiteId: result.netSuiteTransactionId, actorOperatorId: actor });
  assert.equal(linked.netSuiteSyncStatus, "manual_linked");
  const snapshot = remote.created.get(String(result.netSuiteTransactionId));
  snapshot.item.items[0].quantity += 1;
  await assert.rejects(linkReturnNetSuiteTransaction({ recordId: id, transactionType: "return_authorization",
    netsuiteId: result.netSuiteTransactionId, actorOperatorId: actor }), { code: "RETURN_RA_VERIFICATION_FAILED" });
  assert.equal((await reconcileReturnRecords()).failed, 1);
  snapshot.item.items[0].quantity -= 1;
  snapshot.status.refName = "Cancelled";
  assert.equal((await reconcileReturnRecords()).updated, 1);
  assert.equal((await voidReturnRecord({ recordId: id, reason: "Cancelled in NetSuite", actorOperatorId: actor })).status, "voided");
});

test("D1 simultaneous first attempts and repeated submissions produce exactly one RA", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("stock");
  const results = await Promise.all(Array.from({ length: 3 }, () => syncReturnRecord({ recordId: id })));
  assert.ok(results.every(r => r.netSuiteTransactionId === results[0].netSuiteTransactionId));
  assert.equal(remote.created.size, 1);
});

test("D1 more simultaneous retries than database connections still make progress", { timeout: 5000 }, async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  const results = await Promise.all(Array.from({ length: 12 }, () => syncReturnRecord({ recordId: id })));
  assert.equal(results.length, 12);
  assert.ok(results.every(r => r.netSuiteSyncStatus === "succeeded"));
  assert.equal(remote.created.size, 1);
});

test("D1 duplicate external IDs stop creation; a successful create without Location is recovered and verified", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  remote.control.duplicateExternalIds = true;
  await assert.rejects(syncReturnRecord({ recordId: id }), { code: "RETURN_EXTERNAL_ID_AMBIGUOUS" });
  assert.equal(remote.created.size, 0);
  remote.control.duplicateExternalIds = false;
  remote.control.omitLocation = true;
  assert.equal((await syncReturnRecord({ recordId: id })).netSuiteSyncStatus, "succeeded");
  assert.equal(remote.created.size, 1);
});

test("G2 pending worker records uncertain failures and later recovers accepted work", async t => {
  const remote = await fixture(t);
  const id = await seededRecord("pallet");
  remote.control.failAfterCreate = true;
  assert.equal((await processPendingReturnSyncs()).failed, 1);
  assert.equal((await getReturnRecordDetail(id)).netSuiteSyncStatus, "failed");
  assert.equal((await processPendingReturnSyncs()).succeeded, 1);
  assert.equal(remote.created.size, 1);
});

test("V1 legacy automation gate and receiving-yard restrictions still block unauthorized changes", async t => {
  await fixture(t);
  const id = await seededRecord("stock", { version: 1, pendingApproval: true });
  const detail = await getReturnRecordDetail(id);
  await assert.rejects(decideReturnLine({ recordId: id, lineId: detail.lines[0].id, decision: "approved",
    actorOperatorId: actor, allowedReceivingLocationIds: [28] }), { status: 404 });
  await assert.rejects(voidReturnRecord({ recordId: id, reason: "test", actorOperatorId: actor,
    allowedReceivingLocationIds: [28] }), { status: 404 });
  const pallet = await seededRecord("pallet", { version: 1 });
  await assert.rejects(syncReturnRecord({ recordId: pallet }), /automation is disabled/i);
});
