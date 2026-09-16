import assert from "node:assert/strict";
import { suiteql, fetchItemReceiptFromNetSuite } from "../src/netsuite.js";
import { pool, query } from "../src/db.js";
import { config } from "../src/config.js";
import { getNetSuiteM2mAccessToken, isNetSuiteM2mActive } from "../src/netsuite-m2m-runtime.js";

// Read-only inspection of the user's example; no transform or update is called.
try {
  const result = await suiteql("SELECT id, tranid, memo FROM transaction WHERE tranid = 'IR14634' AND type = 'ItemRcpt'");
  assert.equal(result.items?.length, 1);
  const row = result.items[0];
  const record = await fetchItemReceiptFromNetSuite(Number(row.id));
  assert.ok(record);
  const matches = Object.entries(record).filter(([, value]) => typeof value === "string" && value.includes("SN1400333"));
  const token = await isNetSuiteM2mActive() ? await getNetSuiteM2mAccessToken()
    : (await query("SELECT access_token FROM netsuite_tokens WHERE id = 1")).rows[0]?.access_token;
  assert.ok(token);
  const metadataResponse = await fetch(`${config.netsuite.restBaseUrl}/record/v1/metadata-catalog/itemReceipt`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/schema+json" }
  });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  console.log(JSON.stringify({ readAt: new Date().toISOString(), mode: "read-only", id: row.id,
    tranId: record.tranId, memo: record.memo, createdFrom: record.createdFrom,
    matchingFields: Object.fromEntries(matches), customField: metadata.properties?.custbody9 }, null, 2));
} finally {
  await pool.end();
}
