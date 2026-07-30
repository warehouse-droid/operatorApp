import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { closeDb, query, withTransaction } from "./db.js";
import {
  assertCrossYardReturn,
  canonicalReturnQuantity,
  defaultReturnPolicy,
  deriveStockReturnStatus,
  effectiveReturnPolicy,
  normalizeReturnPolicy,
  returnBalance
} from "./return-policy.js";
import {
  buildPalletCreditMemoPayload,
  buildReturnAuthorizationPayload,
  palletActivityQuery,
  summarizePalletActivityRows
} from "./return-netsuite.js";
import {
  assertReturnOrderFullyFulfilled,
  decideReturnLine,
  getReturnReasons,
  getReturnRecordDetail,
  getReturnYardSettings,
  listReturnDrafts,
  listReturnRecords,
  localPalletReserved,
  localStockReserved,
  saveReturnDraft,
  updateReturnYardSettings,
  voidReturnRecord
} from "./return-repository.js";
import { collectReferencedR2Keys } from "./photo-archive-repository.js";

const [migration, performanceMigration, repositorySource, netSuiteSource, netSuiteCoreSource, serverSource, smartItemSource] = await Promise.all([
  fs.readFile(new URL("../migrations/071_returns.sql", import.meta.url), "utf8"),
  fs.readFile(new URL("../migrations/072_return_lookup_performance.sql", import.meta.url), "utf8"),
  fs.readFile(new URL("./return-repository.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./return-netsuite.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./netsuite.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./server.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./smart-scm-item-repository.js", import.meta.url), "utf8")
]);

function purePolicyAndQuantityTests() {
  assert.equal(defaultReturnPolicy("Interlocking"), "ALLOWED");
  assert.equal(defaultReturnPolicy(" interlocking "), "ALLOWED");
  assert.equal(defaultReturnPolicy("Natural Stone"), "APPROVAL_REQUIRED");
  assert.equal(defaultReturnPolicy("Interlocking Paver"), "NOT_RETURNABLE", "Product Type defaults must use exact normalized values.");
  assert.equal(defaultReturnPolicy("Porcelain"), "NOT_RETURNABLE");
  assert.equal(normalizeReturnPolicy("approval required"), "APPROVAL_REQUIRED");
  assert.equal(normalizeReturnPolicy("DEFAULT", { nullable: true }), null);
  assert.deepEqual(
    effectiveReturnPolicy({ productType: "Natural Stone", override: "ALLOWED" }),
    { default: "APPROVAL_REQUIRED", override: "ALLOWED", effective: "ALLOWED", source: "OVERRIDE" }
  );

  assert.deepEqual(
    canonicalReturnQuantity(
      { pallets: 1, layers: 2, sections: 3, pieces: 4 },
      { toPlt: 100, toLyr: 10, toSec: 5, toPcs: 1 }
    ),
    {
      entryMode: "physical_units",
      salesQuantity: 139,
      pallets: 1,
      layers: 2,
      sections: 3,
      pieces: 4
    }
  );
  assert.deepEqual(
    canonicalReturnQuantity({ salesQuantity: 2.5 }, {}),
    {
      entryMode: "sales_uom",
      salesQuantity: 2.5,
      pallets: 0,
      layers: 0,
      sections: 0,
      pieces: 0
    }
  );
  assert.throws(
    () => canonicalReturnQuantity({ pallets: 1, layers: 1 }, { toPlt: 100 }),
    /LAYERS is unavailable/i
  );
  assert.throws(
    () => canonicalReturnQuantity({ pieces: 0.5 }, { toPcs: 1 }),
    /whole number/i
  );

  assert.deepEqual(returnBalance({ fulfilled: 10, netsuiteReturned: 3, localReserved: 2 }), {
    fulfilled: 10,
    netsuiteReturned: 3,
    localReserved: 2,
    available: 5
  });
  assert.equal(returnBalance({ fulfilled: 1, netsuiteReturned: 3 }).available, 0);
  assert.deepEqual(
    summarizePalletActivityRows([
      {
        transaction_id: "101",
        transaction_type: "ItemShip",
        quantity: "12",
        status: "C"
      },
      {
        transaction_id: "102",
        transaction_type: "ItemShip",
        quantity: "8",
        status_text: "Cancelled"
      },
      {
        transaction_id: "201",
        transaction_type: "ItemRcpt",
        quantity: "3",
        externalid: "IR-ONE"
      },
      {
        transaction_id: "202",
        transaction_type: "CustCred",
        quantity: "2",
        status_text: "Void",
        externalid: "CM-VOID"
      },
      {
        transaction_id: "301",
        transaction_type: "CustCred",
        quantity: "99",
        externalid: "CM-ONE"
      }
    ]),
    {
      fulfilled: 12,
      netsuiteReturned: 99,
      externalIds: ["CM-ONE"],
      transactionIds: [301],
      fulfillmentTransactionCount: 1,
      creditMemoTransactionCount: 1
    },
    "PALLET quota must use complete Item Fulfillment and customer Credit Memo history."
  );
  const palletQuery = palletActivityQuery(9001, 1784);
  assert.match(palletQuery, /t\.type = 'ItemShip'[\s\S]*UNION ALL[\s\S]*t\.type = 'CustCred'/);
  assert.match(palletQuery, /INNER JOIN customer c[\s\S]*c\.id = t\.entity[\s\S]*c\.id = 9001/);
  assert.match(palletQuery, /SUM\(ABS\(NVL\(tl\.quantity, 0\)\)\)/);
  assert.doesNotMatch(palletQuery, /\btrandate\s*[<>=]|\bFETCH FIRST\b|\bSalesOrd\b|\bItemRcpt\b/i);
  assert.doesNotThrow(() => assertReturnOrderFullyFulfilled({
    tranid: "SOB-FULL",
    status: "G",
    statusText: "Sales Order : Pending Billing"
  }));
  assert.doesNotThrow(() => assertReturnOrderFullyFulfilled({
    tranid: "SOB-CLOSED",
    status: "SalesOrd:H",
    statusText: "Sales Order : Closed",
    lines: [{
      itemType: "InvtPart",
      salesQuantity: 12,
      fulfilledQuantity: 12
    }]
  }));
  assert.throws(
    () => assertReturnOrderFullyFulfilled({
      tranid: "SOB-CLOSED-PARTIAL",
      status: "H",
      statusText: "Sales Order : Closed",
      lines: [{
        itemType: "InvtPart",
        salesQuantity: 12,
        fulfilledQuantity: 8
      }]
    }),
    (error) => error.code === "ORDER_NOT_FULLY_FULFILLED"
  );
  assert.throws(
    () => assertReturnOrderFullyFulfilled({
      tranid: "SOB-PENDING",
      statusText: "Sales Order : Pending Fulfillment"
    }),
    (error) => error.status === 409
      && error.code === "ORDER_NOT_FULLY_FULFILLED"
      && error.orderStatusText.includes("Pending Fulfillment")
  );
  assert.throws(
    () => assertReturnOrderFullyFulfilled({
      tranid: "SOB-PARTIAL",
      statusText: "Sales Order : Pending Billing/Partially Fulfilled"
    }),
    (error) => error.code === "ORDER_NOT_FULLY_FULFILLED"
  );
  assert.throws(
    () => assertReturnOrderFullyFulfilled({
      tranid: "SOB-PENDING-RAW",
      status: "B",
      statusText: ""
    }),
    (error) => error.code === "ORDER_NOT_FULLY_FULFILLED"
  );
  assert.throws(
    () => assertReturnOrderFullyFulfilled({
      tranid: "SOB-PARTIAL-RAW",
      status: "SalesOrd:E",
      statusText: ""
    }),
    (error) => error.code === "ORDER_NOT_FULLY_FULFILLED"
  );
  assert.throws(
    () => assertReturnOrderFullyFulfilled({
      tranid: "SOB-PENDING-APPROVAL",
      status: "A",
      statusText: "Pending Approval"
    }),
    (error) => error.code === "ORDER_NOT_FULLY_FULFILLED"
  );
  assert.deepEqual(
    assertCrossYardReturn({ orderingLocationId: 28, receivingLocationId: 28 }),
    { crossYard: false, allowed: true }
  );
  assert.deepEqual(
    assertCrossYardReturn({
      orderingLocationId: 28,
      receivingLocationId: 1,
      allowCrossYardReturns: true
    }),
    { crossYard: true, allowed: true }
  );
  assert.throws(
    () => assertCrossYardReturn({ orderingLocationId: 28, receivingLocationId: 1 }),
    (error) => error.status === 409 && error.code === "CROSS_YARD_RETURN_BLOCKED"
  );
  assert.equal(deriveStockReturnStatus([{ approvalStatus: "pending" }]), "pending_approval");
  assert.equal(deriveStockReturnStatus([
    { approvalStatus: "pending" },
    { approvalStatus: "not_required" }
  ]), "partially_pending");
  assert.equal(deriveStockReturnStatus([
    { approvalStatus: "rejected" },
    { approvalStatus: "approved" }
  ]), "partially_rejected");
  assert.equal(deriveStockReturnStatus([{ approvalStatus: "approved" }]), "accepted");
}

function payloadTests() {
  const ra = buildReturnAuthorizationPayload({
    externalId: "MBBS-SR-000001",
    submittedDate: "2026-07-29",
    receivingLocationId: 1,
    memo: "SR-000001 | RB-000001 | SO SOB1 | yard 3445 | plate TEST1",
    lines: [
      {
        sourceSalesOrderLineId: 501,
        netSuiteOrderLine: 2,
        itemId: 1001,
        returnedSalesQuantity: 2,
        rate: 12.5,
        reasonId: 5
      },
      {
        sourceSalesOrderLineId: 501,
        netSuiteOrderLine: 2,
        itemId: 1001,
        returnedSalesQuantity: 1,
        rate: 12.5,
        reasonId: 7
      }
    ]
  });
  assert.equal(ra.externalId, "MBBS-SR-000001");
  assert.notEqual(501, ra.item.items[0].orderLine, "SuiteQL uniquekey must not be sent as REST orderLine.");
  assert.equal(ra.item.items[0].orderLine, 2);
  assert.equal(ra.item.items.length, 2, "Different reasons on one SO line must stay separate.");
  assert.deepEqual(ra.item.items.map((line) => line.custcol_atlas_rc_so.id), ["5", "7"]);

  const cm = buildPalletCreditMemoPayload({
    externalId: "MBBS-PR-000001",
    submittedDate: "2026-07-29",
    customerId: 9001,
    receivingLocationId: 28,
    palletItemId: 600,
    palletQuantity: 4,
    memo: "PR-000001"
  });
  assert.equal(cm.item.items[0].rate, 40);
  assert.equal(cm.item.items[0].quantity, 4);
  assert.equal(cm.item.items[0].custcol_atlas_rc_so.id, "10");
}

function staticIntegrationTests() {
  assert.match(migration, /auto_create_stock_ra boolean NOT NULL DEFAULT false/);
  assert.match(migration, /auto_create_pallet_credit_memo boolean NOT NULL DEFAULT false/);
  assert.match(migration, /idempotency_key text NOT NULL UNIQUE/);
  assert.match(migration, /netsuite_order_line_id bigint NOT NULL/);
  assert.match(migration, /vehicle_plate text NOT NULL,\s+note text,\s+pallet_quantity/);
  assert.match(migration, /return_policy_override IS NULL[\s\S]*ALLOWED[\s\S]*APPROVAL_REQUIRED[\s\S]*NOT_RETURNABLE/);
  assert.match(migration, /return_line_id IS NULL/);
  assert.match(performanceMigration, /idx_return_records_pallet_reservation/);
  assert.match(performanceMigration, /idx_return_lines_stock_reservation/);
  assert.match(repositorySource, /isOperatorReturnPhotoForActor/, "Submitted evidence must belong to the submitting operator.");
  assert.match(repositorySource, /readArchivedPhoto[\s\S]*createPhotoReadToken/, "Submitted evidence must be verified in R2 or the local archive.");
  assert.match(repositorySource, /pg_advisory_xact_lock/);
  assert.match(repositorySource, /America\/Toronto/, "NetSuite transaction dates must use the company timezone.");
  assert.match(
    netSuiteSource,
    /returnAuthorizationParents[\s\S]*credit_link[\s\S]*source_line_id:\s*parent\.source_line_id/,
    "SO→RA→Credit Memo must be mapped back to the source line."
  );
  assert.match(netSuiteSource, /inactiveStatus\(row,\s*\{\s*reject:\s*true\s*\}\)/, "Rejected RAs must release returnable quantity.");
  assert.match(netSuiteCoreSource, /!transform\/returnAuthorization\?replace=item/, "RA transforms must replace the default item sublist.");
  assert.match(netSuiteCoreSource, /salesOrder\/\$\{id\}\?expandSubResources=true/, "REST orderLine values must come from the expanded Sales Order item subresource.");
  assert.match(netSuiteSource, /NETSUITE_ORDER_LINE_AMBIGUOUS/, "Ambiguous REST orderLine mappings must fail closed.");
  assert.match(netSuiteSource, /includeRestLineMapping/);
  assert.match(
    netSuiteSource,
    /returnAuthorizationIds\.length[\s\S]*credit_link\.previousdoc IN/,
    "RA-to-Credit-Memo history should only be queried when the Sales Order has an RA."
  );
  assert.doesNotMatch(
    netSuiteSource.slice(
      netSuiteSource.indexOf("export async function fetchPalletBalanceFromNetSuite"),
      netSuiteSource.indexOf("export async function fetchStockReturnsFromNetSuite")
    ),
    /quantityshiprecv|ItemRcpt/,
    "PALLET balance must not regress to SO fulfillment counters or Item Receipts."
  );
  assert.match(
    repositorySource,
    /if \(!order\)[\s\S]*assertReturnOrderFullyFulfilled\(order\)[\s\S]*attachReturnSalesOrderRestLineMapping/,
    "Incomplete Sales Orders must fail before REST line mapping or return-history calls."
  );
  assert.match(
    repositorySource,
    /\.filter\(\(line\) => line\.returnPolicy\.effective !== "NOT_RETURNABLE"\)[\s\S]*remainingReturnable/,
    "Stock lookup must only expose policy-eligible lines with returnable quantity."
  );
  assert.match(repositorySource, /includeStockReturns = true/);
  assert.match(repositorySource, /includeNetSuiteOrderLines = false/);
  assert.match(repositorySource, /includePalletBalance = true/);
  assert.match(repositorySource, /enforceYardRestriction = true/);
  assert.match(
    repositorySource,
    /includePalletBalance:\s*hasPallet,\s*enforceYardRestriction:\s*hasStock,\s*forcePalletBalance:\s*hasPallet/,
    "Stock-only confirmation must not run the full customer PALLET-history query."
  );
  assert.match(repositorySource, /palletBalance\?\.item/, "The skipped PALLET-balance path must remain null-safe.");
  const submitSource = repositorySource.slice(
    repositorySource.indexOf("export async function submitReturnBatch"),
    repositorySource.indexOf("export async function listReturnRecords")
  );
  assert.ok(
    submitSource.indexOf("lookupReturnSalesOrder") < submitSource.indexOf("getReturnReasons"),
    "The first remote submission lookup must be the Sales Order status check."
  );
  assert.match(repositorySource, /CROSS_YARD_RETURN_BLOCKED[\s\S]*attachReturnSalesOrderRestLineMapping/);
  assert.match(repositorySource, /cachedReturnReasons[\s\S]*void refreshReturnReasons\(\)\.catch/);
  assert.match(netSuiteCoreSource, /expandSubResources=true/, "Manual-link reads must expand item lines.");
  assert.match(serverSource, /app\.post\("\/api\/returns\/submit", requireOperator, requireOperatorAccess/);
  assert.match(
    serverSource,
    /app\.post\("\/api\/returns\/orders\/lookup"[\s\S]*includeStockReturns:\s*returnMode !== "pallet"[\s\S]*enforceYardRestriction:\s*returnMode !== "pallet"/,
    "PALLET-only SO enquiry must skip stock history and ordering-yard enforcement."
  );
  assert.match(serverSource, /app\.get\("\/api\/sales\/returns", requirePrivateSalesRecordAccess/);
  assert.match(serverSource, /app\.post\("\/api\/returns\/:id\/sync\/retry", requireOperator, requireAdmin/);
  assert.match(serverSource, /allowReturnPolicyChange:\s*operatorHasAnyRole\(req\.operator,\s*\["admin"\]\)/);
  assert.match(serverSource, /"netsuiteorderlinesnapshot"/, "Operator payloads must redact expanded NetSuite line snapshots.");
  assert.match(smartItemSource, /Only an admin can change the company-wide Return Policy/);
}

async function databaseTests() {
  const operatorId = crypto.randomUUID();
  const runId = crypto.randomBytes(5).toString("hex");
  await withTransaction(async () => {
    await query(migration);
    await query(
      `INSERT INTO operators (
         id, username, display_name, password_hash, password_salt,
         role, roles, yard_location_ids
       ) VALUES ($1, $2, 'Return Harness', 'hash', 'salt', 'admin', ARRAY['admin']::text[], ARRAY[1]::integer[])`,
      [operatorId, `return-harness-${runId}`]
    );

    const initialSettings = await getReturnYardSettings(1);
    assert.equal(initialSettings.autoCreateStockRa, false);
    assert.equal(initialSettings.autoCreatePalletCreditMemo, false);
    const changedSettings = await updateReturnYardSettings(1, {
      allowCrossYardReturns: true
    }, {
      operatorId,
      allowCrossYard: true
    });
    assert.equal(changedSettings.allowCrossYardReturns, true);
    assert.equal(changedSettings.autoCreateStockRa, false);
    await assert.rejects(
      updateReturnYardSettings(1, {
        allowCrossYardReturns: "false"
      }, {
        operatorId,
        allowCrossYard: true
      }),
      (error) => error.status === 400 && /true or false/i.test(error.message)
    );
    assert.equal((await getReturnYardSettings(1)).allowCrossYardReturns, true);
    const cachedReasons = await getReturnReasons();
    assert.equal(cachedReasons.normalReason.id, 10);
    assert.deepEqual(cachedReasons.qualityReasons.map((reason) => reason.id), [5, 6, 7, 8, 9]);

    const draft = await saveReturnDraft({
      operatorId,
      input: {
        receivingLocationId: 1,
        type: "quality",
        orderId: 123,
        vehiclePlate: "",
        lines: [],
        photos: [`r2://operator/operator-return-photo/2026/07/29/${operatorId}/draft/${runId}-draft.jpg`]
      }
    });
    assert.equal(draft.receivingLocationId, 1);
    assert.ok(draft.idempotencyKey);
    assert.equal((await listReturnDrafts({ operatorId })).length, 1);
    await assert.rejects(
      saveReturnDraft({
        operatorId,
        input: { ...draft, receivingLocationId: 28 }
      }),
      /receiving yard is locked/i
    );

    const batch = await query(
      `INSERT INTO return_batches (
         batch_reference, idempotency_key, operator_id, receiving_location_id,
         receiving_yard_code, vehicle_plate
       ) VALUES ($1, $2, $3, 1, '3445', 'HARNESS')
       RETURNING id`,
      [`RB-H-${runId}`, `harness:${runId}`, operatorId]
    );
    const record = await query(
      `INSERT INTO return_records (
         record_reference, batch_id, record_type, stock_return_type, status,
         operator_id, source_sales_order_id, source_sales_order_ref,
         customer_id, customer_name, ordering_location_id,
         receiving_location_id, receiving_location_name, vehicle_plate,
         external_id, netsuite_sync_status
       ) VALUES (
         $1, $2, 'stock', 'normal', 'pending_approval',
         $3, 123, 'SOB-HARNESS', 456, 'Harness Customer', 1,
         1, '3445', 'HARNESS', $4, 'disabled'
       )
       RETURNING id`,
      [`SR-H-${runId}`, batch.rows[0].id, operatorId, `MBBS-SR-H-${runId}`]
    );
    const line = await query(
      `INSERT INTO return_record_lines (
         return_record_id, source_sales_order_line_id, netsuite_order_line_id, item_id, item_name,
         sales_uom, sales_order_quantity, fulfilled_quantity,
         returned_sales_quantity, entry_mode, return_policy_default,
         return_policy_effective, approval_status, reason_id, reason_code,
         reason_label
       ) VALUES (
         $1, 10001, 2, 20001, 'HARNESS ITEM', 'Each', 10, 10,
         2, 'sales_uom', 'APPROVAL_REQUIRED',
         'APPROVAL_REQUIRED', 'pending', 10, 'GD', 'GD - Good Condition'
       )
       RETURNING id`,
      [record.rows[0].id]
    );
    await query(
      `INSERT INTO return_photos (
         return_record_id, photo_kind, photo_reference, position
       ) VALUES ($1, 'stock', $2, 1)`,
      [record.rows[0].id, `r2://operator/operator-return-photo/2026/07/29/${runId}.jpg`]
    );

    const approved = await decideReturnLine({
      recordId: record.rows[0].id,
      lineId: line.rows[0].id,
      decision: "approved",
      actorOperatorId: operatorId,
      allowedReceivingLocationIds: [1]
    });
    assert.equal(approved.status, "accepted");
    assert.equal(approved.lines[0].approvalStatus, "approved");
    assert.equal(
      (await localStockReserved([10001])).get("10001"),
      2,
      "An unsynced active stock return must reserve its quantity."
    );
    assert.equal(
      (await localStockReserved([10001], [`MBBS-SR-H-${runId}`])).get("10001") || 0,
      0,
      "A remotely observed stock return must not also remain locally reserved."
    );
    await query(
      "UPDATE return_records SET netsuite_transaction_id = 987654321 WHERE id = $1",
      [record.rows[0].id]
    );
    assert.equal(
      (await localStockReserved([10001], [], [987654321])).get("10001") || 0,
      0,
      "A remote transaction ID must close the stock-return crash-window deduplication gap."
    );
    await query(
      "UPDATE return_records SET netsuite_transaction_id = NULL WHERE id = $1",
      [record.rows[0].id]
    );

    const palletRecord = await query(
      `INSERT INTO return_records (
         record_reference, batch_id, record_type, status, operator_id,
         customer_id, customer_name, ordering_location_id,
         receiving_location_id, receiving_location_name, vehicle_plate,
         pallet_quantity, external_id, netsuite_sync_status
       ) VALUES (
         $1, $2, 'pallet', 'accepted', $3,
         789, 'Pallet Harness Customer', 1,
         1, '3445', 'HARNESS', 4, $4, 'disabled'
       )
       RETURNING id`,
      [`PR-H-${runId}`, batch.rows[0].id, operatorId, `MBBS-PR-H-${runId}`]
    );
    assert.equal(
      await localPalletReserved(789),
      4,
      "An unsynced active PALLET return must reserve its quantity."
    );
    assert.equal(
      await localPalletReserved(789, [`MBBS-PR-H-${runId}`]),
      0,
      "A remotely observed Credit Memo must not also remain locally reserved."
    );
    await query(
      "UPDATE return_records SET netsuite_transaction_id = 987654322 WHERE id = $1",
      [palletRecord.rows[0].id]
    );
    assert.equal(
      await localPalletReserved(789, [], [987654322]),
      0,
      "A Credit Memo transaction ID must close the PALLET crash-window deduplication gap."
    );
    const listed = await listReturnRecords({
      receivingLocationIds: [1],
      stockReturnType: "normal",
      search: "SOB-HARNESS"
    });
    assert.equal(listed.records.length, 1);
    const detail = await getReturnRecordDetail(record.rows[0].id, { operatorId });
    assert.equal(detail.photos.length, 1);
    const referencedPhotos = await collectReferencedR2Keys();
    assert.ok(referencedPhotos.some((key) => key.endsWith(`${runId}.jpg`)));
    assert.ok(
      referencedPhotos.some((key) => key.endsWith(`${runId}-draft.jpg`)),
      "Saved return-draft evidence must remain referenced for photo archiving."
    );
    const voided = await voidReturnRecord({
      recordId: record.rows[0].id,
      reason: "Harness correction",
      actorOperatorId: operatorId,
      allowedReceivingLocationIds: [1]
    });
    assert.equal(voided.status, "voided");
  }, { rollback: true });
}

let exitCode = 0;
try {
  purePolicyAndQuantityTests();
  payloadTests();
  staticIntegrationTests();
  if (process.env.RETURN_HARNESS_SKIP_DB !== "1") await databaseTests();
  console.log("Return module harness passed.");
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  await closeDb();
}
process.exitCode = exitCode;
