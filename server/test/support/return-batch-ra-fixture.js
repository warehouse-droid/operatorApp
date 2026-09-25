import assert from "node:assert/strict";
import { query } from "../../src/db.js";
import { config } from "../../src/config.js";
import { getOperatorNetSuitePostingPolicy } from "../../src/operator-netsuite-posting-policy-repository.js";
export const actor = "return-batch-ra-test";
let sequence = 0;
export const reasonPhotos = [`r2://operator/operator-return-photo/2026/09/18/${actor}/test/photo.jpg`];

function fixtureRows(sql, remoteLines, created, control) {
      let items = [];
      if (sql.includes("return_batch_source_links")) {items = control.sourceLinks || [];}
      else if (sql.includes("AS sales_quantity")) {items = remoteLines;}
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
      const keys = body.item.items.map(line => line.orderLine).filter(value => value !== undefined);
      if (new Set(keys).size !== keys.length) {
        return Response.json({ "o:errorDetails": [{ "o:errorCode": "DUPLICATE_KEYS", "o:errorPath": "item.items", detail: "There are multiple sublist lines with the same identifier." }] }, { status: 400 });
      }
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

export async function fixture(t, { enabled = true } = {}) {
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


export async function submitInput({ pallet = false, stock = true, quantity = 1 } = {}) {
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

