import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../../../src/config.js";
import { query, closeDb } from "../../../src/db.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import { operatorNetSuitePostingAdapter } from "../../../src/operator-netsuite-posting-netsuite-adapter.js";

test("real IR transport serializes Memo and Ref No in the source PO transform request", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const previous = { ...config.netsuite }, nativeFetch = globalThis.fetch;
  try {
    config.netsuite.directAccessEnabled = true;
    config.netsuite.restBaseUrl = "https://netsuite.invalid/services/rest";
    await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'reference-fixture',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
    const requests = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, "https://netsuite.invalid");
      requests.push({ path: new URL(url).pathname, method: options.method, payload: JSON.parse(options.body) });
      return new Response(null, { status: 204,
        headers: { location: "https://netsuite.invalid/services/rest/record/v1/itemReceipt/993562" } });
    };
    const draft = buildOperatorNetSuitePostingDraft({ requestId: "653215bb-c49a-4baf-864b-088cd409ae56",
      actorOperatorId: "fixture", functionKey: "receiving", transactionType: "IR", photoRefs: [],
      policy: { gateKey: "operator_netsuite_receiving_ir_3445", revision: 1, effective: true,
        functionKey: "receiving", transactionType: "IR", locationId: 1, yardCode: "3445" },
      localOrderKeys: ["receiving:split"],
      localOperation: { kind: "receiving_receipt", orderId: "-74756816273767", orderType: "purchase_order" },
      targets: [{ sourceOrderKind: "PO", sourceNetSuiteId: 936958, sourceOrderRef: "POB03658", memo: "SN1400333",
        availableLines: [{ orderLine: 15, location: 1, remainingQuantity: 2000 }],
        selectedLines: [{ orderLine: 15, location: 1, quantity: 1305.6, localOrderKey: "receiving:split", localLineId: "-15" }] }] });
    const result = await operatorNetSuitePostingAdapter.transform(draft.steps[0]);
    assert.equal(result.id, 993562);
    assert.deepEqual(requests, [{ path: "/services/rest/record/v1/purchaseorder/936958/!transform/itemreceipt", method: "POST",
      payload: { externalId: "MBBS-OP-653215bb-c49a-4baf-864b-088cd409ae56-1", memo: "SN1400333", custbody9: "SN1400333",
        item: { items: [{ orderLine: 15, quantity: 1305.6, itemReceive: true, location: 1 }] } } }]);
  } finally {
    globalThis.fetch = nativeFetch;
    Object.assign(config.netsuite, previous);
    await closeDb();
  }
});
