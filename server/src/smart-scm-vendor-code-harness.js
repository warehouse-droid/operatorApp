import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { getSmartScmVendorItemCodes } from "./smart-scm-vendor-code-service.js";

const transaction = await beginRollbackContext();

try {
  await transaction.run(async () => {
    const vendorId = 990000001;
    const rootCaseItemId = 990000011;
    const rankedItemId = 990000012;
    const exactItemId = 990000013;

    await query(
      `INSERT INTO scm_netsuite_vendor_item_codes (
         item_id, vendor_id, subsidiary_id, vendor_code, source,
         preferred_vendor, vendor_price, vendor_price_synced_at, synced_at, updated_at
       ) VALUES
         ($1, $4, 1, '0555CEL125105-0', 'item_vendor', true, 12.6, now(), now(), now()),
         ($2, $4, 0, 'GLOBAL-FALLBACK', 'single_vendor_fallback', true, NULL, now(), now(), now()),
         ($2, $4, 1, 'SUBSIDIARY-1', 'item_vendor', false, 10.5, now(), now(), now()),
         ($2, $4, 2, 'SUBSIDIARY-2', 'item_vendor', true, 11.5, now(), now(), now()),
         ($3, $4, 0, 'GLOBAL-ITEM-VENDOR', 'item_vendor', true, 8.5, now(), now(), now()),
         ($3, $4, 1, 'EXACT-SUBSIDIARY', 'item_vendor', false, 9.5, now(), now(), now())`,
      [rootCaseItemId, rankedItemId, exactItemId, vendorId]
    );

    const rootCase = await getSmartScmVendorItemCodes({ vendorId, itemIds: [rootCaseItemId] });
    assert.equal(rootCase.length, 1);
    assert.equal(rootCase[0].vendorCode, "0555CEL125105-0",
      "An unspecified subsidiary must still return a code stored against a real NetSuite subsidiary.");
    assert.equal(rootCase[0].subsidiaryId, 1);
    assert.equal(rootCase[0].vendorPrice, 12.6,
      "The vendor-specific NetSuite price must travel with its selected Item Vendor code.");
    assert(rootCase[0].vendorPriceSyncedAt,
      "A checked vendor price needs a timestamp so an empty/zero price does not trigger endless refreshes.");

    const unspecified = await getSmartScmVendorItemCodes({ vendorId, itemIds: [rankedItemId] });
    assert.equal(unspecified[0].vendorCode, "SUBSIDIARY-2",
      "Without a requested subsidiary, an authoritative preferred Item Vendor code must win deterministically.");
    assert.equal(unspecified[0].vendorPrice, 11.5);

    const requested = await getSmartScmVendorItemCodes({
      vendorId,
      itemIds: [rankedItemId],
      subsidiaryId: 1
    });
    assert.equal(requested[0].vendorCode, "SUBSIDIARY-1",
      "An exact requested subsidiary must outrank other subsidiaries and the global fallback.");

    const globalFallback = await getSmartScmVendorItemCodes({
      vendorId,
      itemIds: [rankedItemId],
      subsidiaryId: 3
    });
    assert.equal(globalFallback[0].vendorCode, "GLOBAL-FALLBACK",
      "A global code must remain available when the requested subsidiary has no exact row.");

    const exactOverGlobal = await getSmartScmVendorItemCodes({
      vendorId,
      itemIds: [exactItemId],
      subsidiaryId: 1
    });
    assert.equal(exactOverGlobal[0].vendorCode, "EXACT-SUBSIDIARY",
      "An exact subsidiary row must outrank a preferred global row.");
  });

  console.log("Smart SCM vendor-code subsidiary selection contracts passed.");
} finally {
  await transaction.rollback();
  await closeDb();
}
