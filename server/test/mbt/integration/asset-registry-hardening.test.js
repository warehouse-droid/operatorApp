import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { MbtError } from "../../../src/mbt/errors.js";
import {
  compareMbtAssetMovements,
  getMbtAssetReconciliationBatch,
  getMbtBinAssetTimeline,
  listMbtBinAssets,
  registerMbtBinAsset,
  resolveMbtAssetMovementVariance,
  updateMbtBinAssetAttributes
} from "../../../src/mbt/asset-registry-service.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PREFIX = `P3-H-${RUN_ID}`;
const YARD_ID = "00000000-0000-4000-8000-000000012441";
const YARD_CODE = "12441";
const BIN_TYPE_ID = "00000000-0000-4000-8000-000000000014";
const OCCURRED_AT = "2036-08-03T12:34:56.000Z";
const CONDITION_CODE = `P3C${RUN_ID.slice(0, 12)}`;
const INACTIVE_CONDITION_CODE = `P3I${RUN_ID.slice(0, 12)}`;
const DUMP_SITE_ID = crypto.randomUUID();
const INACTIVE_DUMP_SITE_ID = crypto.randomUUID();
const CUSTOMER_SITE_ID = crypto.randomUUID();
const ACTOR = Object.freeze({
  operatorId: `p3-asset-hardening-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});

let commandSequence = 0;
let truckId = "";
let inactiveTruckId = "";

/** @param {string} label */
function commandIdentity(label) {
  commandSequence += 1;
  const identity = `${RUN_ID}-${label}-${commandSequence}`;
  return {
    idempotencyKey: `p3-hard-idem-${identity}`,
    correlationId: `p3-hard-corr-${identity}`,
    requestId: `p3-hard-req-${identity}`
  };
}

/**
 * @param {string} label
 * @param {Record<string, unknown>} [assetOverrides]
 * @param {Record<string, unknown>} [stateOverrides]
 */
function registration(label, assetOverrides = {}, stateOverrides = {}) {
  const identity = commandIdentity(label);
  const unique = `${RUN_ID}-${commandSequence}`;
  return {
    actor: ACTOR,
    asset: {
      assetCode: `${PREFIX}-${label}-${commandSequence}`,
      qrCode: `P3-H-QR-${unique}`,
      barcode: `P3-H-BAR-${unique}`,
      binTypeId: BIN_TYPE_ID,
      homeYardId: YARD_ID,
      tareWeightKg: "1000.000",
      conditionCode: null,
      operationalNotes: `Asset hardening fixture ${label}`,
      active: true,
      underMaintenance: false,
      ...assetOverrides
    },
    initialState: {
      lifecycleStatus: "available",
      location: {
        kind: "yard",
        reference: YARD_CODE,
        yardId: YARD_ID
      },
      occurredAt: OCCURRED_AT,
      ...stateOverrides
    },
    reason: `Exercise asset registry ${label}`,
    ...identity
  };
}

/** @param {unknown} error @param {string} code @param {number} status */
function isMbtFailure(error, code, status) {
  return error instanceof MbtError && error.code === code && error.status === status;
}

/** @param {Promise<unknown>} operation @param {string} code @param {number} [status] */
async function rejectsMbt(operation, code, status = 400) {
  await assert.rejects(operation, (error) => isMbtFailure(error, code, status));
}

/** @param {ReturnType<typeof registration>} input @param {Record<string, unknown>} [overrides] */
function manualOpening(input, overrides = {}) {
  return {
    manualRowId: `manual-${RUN_ID}-${commandSequence}-${crypto.randomUUID()}`,
    assetCode: input.asset.assetCode,
    assetSequence: 1,
    beforeStatus: null,
    afterStatus: input.initialState.lifecycleStatus,
    beforeLocationKind: null,
    afterLocationKind: input.initialState.location.kind,
    afterLocationReference: input.initialState.location.reference ?? null,
    truckId: input.initialState.location.truckId ?? null,
    driverId: null,
    visitId: null,
    occurredAt: input.initialState.occurredAt instanceof Date
      ? input.initialState.occurredAt.toISOString()
      : input.initialState.occurredAt,
    ...overrides
  };
}

/** @param {unknown} rows @param {string} label */
function comparison(rows, label) {
  return {
    actor: ACTOR,
    rows,
    reason: `Exercise reconciliation ${label}`,
    ...commandIdentity(`comparison-${label}`)
  };
}

/** @param {string} comparisonRowId @param {string} label @param {string} [decision] */
function resolution(comparisonRowId, label, decision = "evidence_only") {
  return {
    actor: ACTOR,
    comparisonRowId,
    decision,
    auditNote: `Resolve synthetic variance ${label}`,
    ...commandIdentity(`resolution-${label}`)
  };
}

before(async () => {
  const customerId = (BigInt(`0x${RUN_ID.slice(0, 12)}`) + 10_000n).toString();
  const addressId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_bin_condition_codes (
       condition_code, display_name, active, created_by, updated_by
     ) VALUES
       ($1, $2, true, 'mbt-test', 'mbt-test'),
       ($3, $4, false, 'mbt-test', 'mbt-test')`,
    [
      CONDITION_CODE,
      `Hardening condition ${RUN_ID}`,
      INACTIVE_CONDITION_CODE,
      `Inactive hardening condition ${RUN_ID}`
    ]
  );
  await query(
    `INSERT INTO mbt_dump_sites (
       dump_site_id, dump_site_code, display_name, active, created_by, updated_by
     ) VALUES
       ($1, $2, $3, true, 'mbt-test', 'mbt-test'),
       ($4, $5, $6, false, 'mbt-test', 'mbt-test')`,
    [
      DUMP_SITE_ID,
      `P3-D-${RUN_ID}`,
      `Hardening dump ${RUN_ID}`,
      INACTIVE_DUMP_SITE_ID,
      `P3-DI-${RUN_ID}`,
      `Inactive hardening dump ${RUN_ID}`
    ]
  );
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, $3, 'CAD', now(), 'asset-hardening-v1', $4)`,
    [customerId, `P3-C-${RUN_ID}`, `Hardening customer ${RUN_ID}`, "c".repeat(64)]
  );
  await query(
    `INSERT INTO netsuite_customer_addresses (
       address_id, customer_netsuite_id, netsuite_address_id, label,
       address_line_1, city, region, postal_code, country_code,
       source_modified_at, source_version, payload_hash
     ) VALUES (
       $1, $2, $3, 'Hardening site', '1 Test Lane', 'Toronto', 'ON',
       'M1M 1M1', 'CA', now(), 'asset-hardening-v1', $4
     )`,
    [addressId, customerId, `P3-A-${RUN_ID}`, "d".repeat(64)]
  );
  await query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id, created_by, updated_by
     ) VALUES ($1, $2, $3, 'mbt-test', 'mbt-test')`,
    [CUSTOMER_SITE_ID, customerId, addressId]
  );
  const trucks = await query(
    `INSERT INTO dispatch_trucks (plate, active)
     VALUES ($1, true), ($2, false)
     RETURNING id::text, active`,
    [`P3H${RUN_ID.slice(0, 10)}`, `P3I${RUN_ID.slice(0, 10)}`]
  );
  truckId = trucks.rows.find((row) => row.active)?.id;
  inactiveTruckId = trucks.rows.find((row) => !row.active)?.id;
  assert.ok(truckId);
  assert.ok(inactiveTruckId);
});

after(async () => {
  await closeDb();
});

test("P3-F11 hardening: supported initial locations and registration defaults stay atomic", async () => {
  const cases = [
    registration(
      "unknown",
      {
        qrCode: undefined,
        barcode: undefined,
        tareWeightKg: null,
        operationalNotes: undefined,
        active: undefined,
        underMaintenance: undefined
      },
      {
        lifecycleStatus: "lost",
        location: { kind: "unknown" },
        occurredAt: new Date(OCCURRED_AT)
      }
    ),
    registration(
      "dump",
      { conditionCode: CONDITION_CODE, active: false, underMaintenance: true },
      {
        lifecycleStatus: "at_dump",
        location: {
          kind: "dump_site",
          reference: `P3-D-${RUN_ID}`,
          dumpSiteId: DUMP_SITE_ID
        }
      }
    ),
    registration("customer", {}, {
      lifecycleStatus: "at_customer",
      location: {
        kind: "customer_site",
        reference: `P3-C-${RUN_ID}`,
        customerSiteProfileId: CUSTOMER_SITE_ID
      }
    }),
    registration("truck", {}, {
      lifecycleStatus: "on_truck",
      location: {
        kind: "truck",
        reference: `P3H${RUN_ID.slice(0, 10)}`,
        truckId
      }
    })
  ];

  for (const input of cases) {
    const result = await registerMbtBinAsset(input);
    assert.equal(result.status, 201);
    assert.equal(result.body.asset.currentState.lifecycleStatus, input.initialState.lifecycleStatus);
    assert.equal(result.body.asset.currentState.locationKind, input.initialState.location.kind);
  }
  assert.equal(cases[0].asset.active, undefined);
});

test("P3-F11 hardening: malformed asset identities and states fail before partial evidence", async () => {
  const malformed = [
    [{ ...registration("asset-object"), asset: null }, "MBT_ASSET_INPUT_INVALID"],
    [{ ...registration("state-object"), initialState: null }, "MBT_ASSET_INPUT_INVALID"],
    [registration("active-type", { active: "yes" }), "MBT_ASSET_INPUT_INVALID"],
    [registration("maintenance-type", { underMaintenance: 1 }), "MBT_ASSET_INPUT_INVALID"],
    [registration("tare-negative", { tareWeightKg: -1 }), "MBT_ASSET_INPUT_INVALID"],
    [registration("tare-infinite", { tareWeightKg: Number.POSITIVE_INFINITY }), "MBT_ASSET_INPUT_INVALID"],
    [registration("time-invalid", {}, { occurredAt: "not-a-date" }), "MBT_ASSET_INPUT_INVALID"],
    [registration("location-object", {}, { location: null }), "MBT_ASSET_INPUT_INVALID"],
    [registration("location-kind", {}, { location: { kind: "warehouse" } }), "MBT_ASSET_STATE_INVALID"],
    [registration("unknown-has-id", {}, {
      lifecycleStatus: "lost",
      location: { kind: "unknown", yardId: YARD_ID }
    }), "MBT_ASSET_STATE_INVALID"],
    [registration("yard-missing-id", {}, {
      location: { kind: "yard", reference: YARD_CODE }
    }), "MBT_ASSET_STATE_INVALID"],
    [registration("yard-two-ids", {}, {
      location: { kind: "yard", yardId: YARD_ID, dumpSiteId: DUMP_SITE_ID }
    }), "MBT_ASSET_STATE_INVALID"],
    [registration("status-kind", {}, {
      lifecycleStatus: "on_truck",
      location: { kind: "yard", yardId: YARD_ID }
    }), "MBT_ASSET_STATE_INVALID"],
    [registration("status-invalid", {}, { lifecycleStatus: "missing" }), "MBT_ASSET_STATE_INVALID"],
    [registration("condition-missing", { conditionCode: "NO_SUCH_CONDITION" }), "MBT_ASSET_REFERENCE_INVALID"],
    [registration("condition-inactive", { conditionCode: INACTIVE_CONDITION_CODE }), "MBT_ASSET_REFERENCE_INVALID"],
    [registration("customer-missing", {}, {
      lifecycleStatus: "at_customer",
      location: { kind: "customer_site", customerSiteProfileId: crypto.randomUUID() }
    }), "MBT_ASSET_REFERENCE_INVALID"],
    [registration("dump-missing", {}, {
      lifecycleStatus: "at_dump",
      location: { kind: "dump_site", dumpSiteId: crypto.randomUUID() }
    }), "MBT_ASSET_REFERENCE_INVALID"],
    [registration("dump-inactive", {}, {
      lifecycleStatus: "at_dump",
      location: { kind: "dump_site", dumpSiteId: INACTIVE_DUMP_SITE_ID }
    }), "MBT_ASSET_REFERENCE_INVALID"],
    [registration("truck-missing", {}, {
      lifecycleStatus: "on_truck",
      location: { kind: "truck", truckId: "9223372036854775806" }
    }), "MBT_ASSET_REFERENCE_INVALID"],
    [registration("truck-inactive", {}, {
      lifecycleStatus: "on_truck",
      location: { kind: "truck", truckId: inactiveTruckId }
    }), "MBT_ASSET_REFERENCE_INVALID"]
  ];

  for (const [input, code] of malformed) {
    await rejectsMbt(registerMbtBinAsset(input), code);
  }
});

test("P3-F11 hardening: registry pagination and timeline errors are bounded and explicit", async () => {
  const firstInput = registration("page-a");
  const secondInput = registration("page-b");
  await registerMbtBinAsset(firstInput);
  await registerMbtBinAsset(secondInput);

  const firstPage = await listMbtBinAssets({ query: `${PREFIX}-page-`, limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await listMbtBinAssets({
    query: `${PREFIX}-page-`,
    limit: 1,
    cursor: firstPage.nextCursor
  });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].assetId, firstPage.items[0].assetId);
  assert.equal(secondPage.nextCursor, null);
  assert.equal((await listMbtBinAssets()).schemaVersion, "mbt-assets-v1");

  for (const limit of [0, 101, 1.5]) {
    await rejectsMbt(listMbtBinAssets({ limit }), "MBT_ASSET_INPUT_INVALID");
  }
  for (const cursor of ["not-json", Buffer.from(JSON.stringify(["only-one"])).toString("base64url")]) {
    await rejectsMbt(listMbtBinAssets({ cursor }), "MBT_ASSET_CURSOR_INVALID");
  }
  await rejectsMbt(getMbtBinAssetTimeline(""), "MBT_ASSET_INPUT_INVALID");
  await rejectsMbt(getMbtBinAssetTimeline(crypto.randomUUID()), "MBT_ASSET_NOT_FOUND", 404);
});

test("P3-F11 hardening: partial attribute updates enforce identity, revision, and uniqueness", async () => {
  const input = registration("update-target");
  const otherInput = registration("update-other");
  const created = await registerMbtBinAsset(input);
  await registerMbtBinAsset(otherInput);
  const assetId = created.body.asset.assetId;

  const partial = await updateMbtBinAssetAttributes({
    actor: ACTOR,
    assetId,
    attributes: { operationalNotes: "Partial edit" },
    expectedRevision: 1,
    reason: "Exercise partial edit",
    ...commandIdentity("partial-update")
  });
  assert.equal(partial.body.asset.revision, 2);
  assert.equal(partial.body.asset.operationalNotes, "Partial edit");

  const cleared = await updateMbtBinAssetAttributes({
    actor: ACTOR,
    assetId,
    attributes: {
      qrCode: "",
      barcode: null,
      tareWeightKg: "",
      conditionCode: CONDITION_CODE,
      operationalNotes: null,
      active: false,
      underMaintenance: true
    },
    expectedRevision: 2,
    reason: "Exercise nullable and boolean edit",
    ...commandIdentity("clear-update")
  });
  assert.equal(cleared.body.asset.revision, 3);
  assert.equal(cleared.body.asset.qrCode, null);
  assert.equal(cleared.body.asset.tareWeightKg, null);
  assert.equal(cleared.body.asset.conditionCode, CONDITION_CODE);
  assert.equal(cleared.body.asset.active, false);
  assert.equal(cleared.body.asset.underMaintenance, true);

  const invalidCases = [
    {
      assetId,
      attributes: { assetCode: "forbidden" },
      expectedRevision: 3,
      code: "MBT_ASSET_INPUT_INVALID",
      status: 400
    },
    {
      assetId,
      attributes: { active: "yes" },
      expectedRevision: 3,
      code: "MBT_ASSET_INPUT_INVALID",
      status: 400
    },
    {
      assetId,
      attributes: { tareWeightKg: -1 },
      expectedRevision: 3,
      code: "MBT_ASSET_INPUT_INVALID",
      status: 400
    },
    {
      assetId,
      attributes: { conditionCode: "NO_SUCH_CONDITION" },
      expectedRevision: 3,
      code: "MBT_ASSET_REFERENCE_INVALID",
      status: 400
    },
    {
      assetId,
      attributes: { operationalNotes: "stale" },
      expectedRevision: 1,
      code: "MBT_STALE_REVISION",
      status: 409
    },
    {
      assetId: crypto.randomUUID(),
      attributes: { operationalNotes: "missing" },
      expectedRevision: 1,
      code: "MBT_ASSET_NOT_FOUND",
      status: 404
    },
    {
      assetId,
      attributes: { qrCode: otherInput.asset.qrCode },
      expectedRevision: 3,
      code: "MBT_ASSET_DUPLICATE",
      status: 409
    }
  ];
  for (const [index, fixture] of invalidCases.entries()) {
    await rejectsMbt(updateMbtBinAssetAttributes({
      actor: ACTOR,
      assetId: fixture.assetId,
      attributes: fixture.attributes,
      expectedRevision: fixture.expectedRevision,
      reason: `Exercise rejected edit ${index}`,
      ...commandIdentity(`invalid-update-${index}`)
    }), fixture.code, fixture.status);
  }
});

test("P3-F23 hardening: malformed and missing manual movements cannot create comparison evidence", async () => {
  const input = registration("compare-errors");
  await registerMbtBinAsset(input);
  const valid = manualOpening(input);
  const invalidRows = [
    null,
    [],
    [null],
    [{ ...valid, beforeStatus: "invalid" }],
    [{ ...valid, afterStatus: "invalid" }],
    [{ ...valid, beforeLocationKind: "invalid" }],
    [{ ...valid, afterLocationKind: "invalid" }],
    [{ ...valid, assetSequence: 0 }],
    [{ ...valid, occurredAt: "invalid" }],
    [{ ...valid, manualRowId: "same" }, { ...valid, manualRowId: "same", assetSequence: 2 }],
    [{ ...valid, manualRowId: "first" }, { ...valid, manualRowId: "second" }],
    [{ ...valid, manualRowId: "unknown", assetCode: `${PREFIX}-missing` }]
  ];
  const expectedCodes = [
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_ASSET_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_ASSET_INPUT_INVALID",
    "MBT_ASSET_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_RECONCILIATION_INPUT_INVALID",
    "MBT_RECONCILIATION_REFERENCE_INVALID"
  ];
  for (const [index, rows] of invalidRows.entries()) {
    await rejectsMbt(
      compareMbtAssetMovements(comparison(rows, `invalid-${index}`)),
      expectedCodes[index]
    );
  }
  await rejectsMbt(
    getMbtAssetReconciliationBatch(crypto.randomUUID()),
    "MBT_RECONCILIATION_NOT_FOUND",
    404
  );
});

test("P3-F23 hardening: resolution rejects invalid, missing, matched, and already-resolved rows", async () => {
  const input = registration("resolution-errors");
  await registerMbtBinAsset(input);
  const batch = await compareMbtAssetMovements(comparison([
    manualOpening(input),
    manualOpening(input, {
      manualRowId: `variance-${RUN_ID}`,
      assetSequence: 1,
      afterStatus: "maintenance"
    })
  ], "resolution-errors")).catch(async (error) => {
    assert.ok(isMbtFailure(error, "MBT_RECONCILIATION_INPUT_INVALID", 400));
    return compareMbtAssetMovements(comparison([
      manualOpening(input, { afterStatus: "maintenance" })
    ], "resolution-variance"));
  });

  const variance = batch.body.rows.find((row) => row.status === "open_variance");
  assert.ok(variance);
  await rejectsMbt(
    resolveMbtAssetMovementVariance(resolution(variance.comparisonRowId, "decision", "unsupported")),
    "MBT_RECONCILIATION_INPUT_INVALID"
  );
  await rejectsMbt(
    resolveMbtAssetMovementVariance(resolution(crypto.randomUUID(), "missing")),
    "MBT_RECONCILIATION_NOT_FOUND",
    404
  );

  const matchedInput = registration("resolution-match");
  await registerMbtBinAsset(matchedInput);
  const matchedBatch = await compareMbtAssetMovements(comparison([
    manualOpening(matchedInput)
  ], "resolution-match"));
  await rejectsMbt(
    resolveMbtAssetMovementVariance(resolution(
      matchedBatch.body.rows[0].comparisonRowId,
      "matched"
    )),
    "MBT_RECONCILIATION_NOT_OPEN",
    409
  );

  await resolveMbtAssetMovementVariance(resolution(variance.comparisonRowId, "first"));
  await rejectsMbt(
    resolveMbtAssetMovementVariance(resolution(variance.comparisonRowId, "again")),
    "MBT_RECONCILIATION_ALREADY_RESOLVED",
    409
  );
});

test("P3-F23 hardening: simultaneous resolution commands append one decision", async () => {
  const input = registration("resolution-race");
  await registerMbtBinAsset(input);
  const batch = await compareMbtAssetMovements(comparison([
    manualOpening(input, { afterStatus: "maintenance" })
  ], "resolution-race"));
  const comparisonRowId = batch.body.rows[0].comparisonRowId;
  const attempts = await Promise.allSettled([
    resolveMbtAssetMovementVariance(resolution(comparisonRowId, "race-a")),
    resolveMbtAssetMovementVariance(resolution(comparisonRowId, "race-b"))
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const rejected = attempts.find(({ status }) => status === "rejected");
  assert.ok(rejected && isMbtFailure(
    rejected.reason,
    "MBT_RECONCILIATION_ALREADY_RESOLVED",
    409
  ));
  const durable = await query(
    "SELECT count(*)::int AS count FROM mbt_asset_reconciliation_resolutions WHERE comparison_row_id = $1",
    [comparisonRowId]
  );
  assert.deepEqual(durable.rows[0], { count: 1 });
});
