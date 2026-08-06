import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access } from "node:fs/promises";
import test, { after } from "node:test";

import { closeDb, pool, query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const BASE_ID = 80_000_000 + Number.parseInt(RUN_ID.slice(0, 6), 16);
const SUBSIDIARY_ID = 70_000_000 + Number.parseInt(RUN_ID.slice(6, 12), 16);
const MODIFIED_A = "2026-08-03T10:00:00.000Z";
const MODIFIED_B = "2026-08-03T11:00:00.000Z";
const MODIFIED_C = "2026-08-03T12:00:00.000Z";

async function optionalModule(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  try {
    await access(url);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({});
    }
    throw error;
  }
  return import(url.href);
}

const sourceModule = await optionalModule("../../../src/mbt/netsuite-customer-source.js");
const syncModule = await optionalModule("../../../src/mbt/customer-sync-service.js");
const contractModule = await optionalModule("../../../src/mbt/customer-master-contract.js");

function requiredFunction(module, name) {
  assert.equal(
    typeof module[name],
    "function",
    `P3.3 requires the production export ${name}; this is the intended RED boundary.`
  );
  return module[name];
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function customerAggregate(netsuiteId, overrides = {}) {
  const sourceModifiedAt = overrides.sourceModifiedAt || MODIFIED_A;
  const sourceVersion = overrides.sourceVersion || `ns-${sourceModifiedAt}-${netsuiteId}`;
  const sourceKind = overrides.sourceKind || "netsuite_read";
  const marker = overrides.marker || `customer-${netsuiteId}`;
  const aggregate = {
    netsuiteId,
    entityNumber: overrides.entityNumber || String(netsuiteId),
    legalName: overrides.legalName || `Synthetic Legal ${marker}`,
    displayName: overrides.displayName || `Synthetic Display ${marker}`,
    currency: "CAD",
    terms: "NET30",
    taxStatus: "taxable",
    creditStatus: "good",
    email: `${marker}@example.invalid`,
    phone: `555${String(netsuiteId).slice(-7).padStart(7, "0")}`,
    active: overrides.active ?? true,
    sourceKind,
    sourceAccountId: overrides.sourceAccountId || `P3_SYNTH_${RUN_ID}`,
    sourceModifiedAt,
    sourceVersion,
    subsidiaries: [{
      netsuiteId: SUBSIDIARY_ID,
      relationshipName: "Mr Bin Trucking synthetic fixture",
      primary: true,
      active: true,
      sourceModifiedAt,
      sourceVersion: `${sourceVersion}-subsidiary`
    }],
    addresses: [{
      netsuiteAddressId: `ADDR-${netsuiteId}`,
      label: "Synthetic service site",
      shippingDefault: true,
      billingDefault: false,
      addressee: `Synthetic ${marker}`,
      addressLine1: `${netsuiteId % 1000} Test Route`,
      city: "Fixtureville",
      region: "ON",
      postalCode: "A1A 1A1",
      countryCode: "CA",
      phone: "5550000000",
      active: true,
      sourceModifiedAt,
      sourceVersion: `${sourceVersion}-address`
    }],
    contacts: [{
      netsuiteContactId: `CONTACT-${netsuiteId}`,
      displayName: `Synthetic Contact ${netsuiteId}`,
      firstName: "Synthetic",
      lastName: `Contact-${netsuiteId}`,
      email: `contact-${netsuiteId}@example.invalid`,
      phone: "5550000001",
      primary: true,
      active: true,
      sourceModifiedAt,
      sourceVersion: `${sourceVersion}-contact`
    }]
  };
  return {
    ...aggregate,
    payloadHash: overrides.payloadHash || hash(aggregate)
  };
}

function cursor(modifiedAt, internalId) {
  return { modifiedAt, internalId };
}

function sourcePage(records, {
  nextCursor = null,
  complete = false,
  snapshotComplete = false
} = {}) {
  return { records, nextCursor, complete, snapshotComplete };
}

function tracedSource(pages, trace = []) {
  let pageIndex = 0;
  return {
    trace,
    mutationCalls: 0,
    async fetchPage(input) {
      trace.push(structuredClone(input));
      const page = pages[pageIndex];
      pageIndex += 1;
      assert.ok(page, `Unexpected customer source page ${pageIndex}.`);
      return structuredClone(page);
    }
  };
}

function syncInput(label, source, {
  syncKind = "full_reconciliation",
  syncKey = `p3:${RUN_ID}:${label}`
} = {}) {
  return {
    syncKey,
    accountId: `P3_SYNTH_${RUN_ID}`,
    subsidiaryId: SUBSIDIARY_ID,
    syncKind,
    sourceKind: "netsuite_read",
    correlationId: `p3-customer-sync-${RUN_ID}-${label}`,
    requestedBy: `p3-customer-admin-${RUN_ID}`,
    pageSize: 2,
    source
  };
}

function applyInput(label, sourceKind, aggregates, overrides = {}) {
  return {
    accountId: `P3_SYNTH_${RUN_ID}`,
    subsidiaryId: SUBSIDIARY_ID,
    sourceKind,
    sourceAsOf: overrides.sourceAsOf || MODIFIED_A,
    sourceVersion: overrides.sourceVersion || `${sourceKind}-${label}`,
    aggregates,
    correlationId: `p3-customer-apply-${RUN_ID}-${label}`,
    idempotencyKey: overrides.idempotencyKey || `p3-customer-idem-${RUN_ID}-${label}`,
    actorId: `p3-customer-admin-${RUN_ID}`
  };
}

async function canonicalRows(ids) {
  const result = await query(
    `SELECT netsuite_id::text AS netsuite_id, entity_number, legal_name,
            display_name, currency, active, source_modified_at, source_version,
            payload_hash
       FROM netsuite_customers
      WHERE netsuite_id = ANY($1::bigint[])
      ORDER BY netsuite_id`,
    [ids]
  );
  return result.rows;
}

async function aggregateCounts(ids) {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM netsuite_customers
         WHERE netsuite_id = ANY($1::bigint[])) AS customers,
       (SELECT count(*)::int FROM netsuite_customer_subsidiaries
         WHERE customer_netsuite_id = ANY($1::bigint[])) AS subsidiaries,
       (SELECT count(*)::int FROM netsuite_customer_addresses
         WHERE customer_netsuite_id = ANY($1::bigint[])) AS addresses,
       (SELECT count(*)::int FROM netsuite_customer_contacts
         WHERE customer_netsuite_id = ANY($1::bigint[])) AS contacts,
       (SELECT count(*)::int FROM return_customer_directory
         WHERE netsuite_customer_id = ANY($1::bigint[])) AS returns_rows`,
    [ids]
  );
  return result.rows[0];
}

async function syncState(syncKey) {
  const result = await query(
    `SELECT incremental_cursor_modified_at, incremental_cursor_external_id,
            last_incremental_run_id, last_complete_full_run_id,
            last_success_at, revision::int AS revision
       FROM netsuite_customer_sync_state
      WHERE sync_key = $1`,
    [syncKey]
  );
  return result.rows[0] || null;
}

after(async () => {
  await closeDb();
});

test("P3-F01: a narrow read-only source completes equal-timestamp pages without loss", async () => {
  const createReadOnlyNetSuiteCustomerSource = requiredFunction(
    sourceModule,
    "createReadOnlyNetSuiteCustomerSource"
  );
  const runCustomerSync = requiredFunction(syncModule, "runCustomerSync");
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  const ids = [BASE_ID + 1, BASE_ID + 2, BASE_ID + 3, BASE_ID + 4];
  const pages = [
    sourcePage(ids.slice(0, 2).map((id) => customerAggregate(id)), {
      nextCursor: cursor(MODIFIED_A, ids[1])
    }),
    sourcePage([
      customerAggregate(ids[2]),
      customerAggregate(ids[3], { sourceModifiedAt: MODIFIED_B })
    ], {
      nextCursor: cursor(MODIFIED_B, ids[3]),
      complete: true,
      snapshotComplete: true
    })
  ];
  const queries = [];
  let mutations = 0;
  const source = createReadOnlyNetSuiteCustomerSource({
    async queryCustomers(input) {
      queries.push(structuredClone(input));
      return structuredClone(pages[queries.length - 1]);
    },
    async mutationTransport() {
      mutations += 1;
      throw new Error("A read-only customer source must never mutate NetSuite.");
    }
  });
  assert.deepEqual(
    Object.keys(source).filter((key) => /create|update|delete|upsert|mutate|write/i.test(key)),
    []
  );

  const syncKey = `p3:${RUN_ID}:full-equal-time`;
  const result = await runCustomerSync(pool, syncInput("full-equal-time", source, { syncKey }));
  assert.equal(result.status, "completed");
  assert.equal(result.pagesApplied, 2);
  assert.equal(result.recordsSeen, 4);
  assert.equal(result.created, 4);
  assert.equal(result.conflicted, 0);
  assert.equal(mutations, 0);
  assert.deepEqual(queries.map(({ cursor: value }) => value), [
    null,
    cursor(MODIFIED_A, ids[1])
  ]);
  assert.deepEqual(await aggregateCounts(ids), {
    customers: 4,
    subsidiaries: 4,
    addresses: 4,
    contacts: 4,
    returns_rows: 4
  });
  const state = await syncState(syncKey);
  assert.equal(new Date(state.incremental_cursor_modified_at).toISOString(), MODIFIED_B);
  assert.equal(state.incremental_cursor_external_id, String(ids[3]));
  assert.ok(state.last_complete_full_run_id);
  const eventPage = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: ids,
    afterSequence: 0,
    limit: 100
  });
  assert.equal(eventPage.contract, "customer-master/v1");
  assert.deepEqual(
    eventPage.events.map(({ customerNetSuiteId }) => customerNetSuiteId).sort((a, b) => a - b),
    ids
  );
});

test("P3-F01: two full reconciliations and one incremental are exact and replay-safe", async () => {
  const runCustomerSync = requiredFunction(syncModule, "runCustomerSync");
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  const ids = [BASE_ID + 20, BASE_ID + 21, BASE_ID + 22];
  const initial = ids.slice(0, 2).map((id) => customerAggregate(id));
  const syncKey = `p3:${RUN_ID}:repeat-and-increment`;
  const first = await runCustomerSync(pool, syncInput(
    "repeat-full-1",
    tracedSource([sourcePage(initial, {
      nextCursor: cursor(MODIFIED_A, ids[1]),
      complete: true,
      snapshotComplete: true
    })]),
    { syncKey }
  ));
  assert.deepEqual({ created: first.created, updated: first.updated, unchanged: first.unchanged }, {
    created: 2,
    updated: 0,
    unchanged: 0
  });
  const firstEvents = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: ids,
    afterSequence: 0,
    limit: 100
  });

  const second = await runCustomerSync(pool, syncInput(
    "repeat-full-2",
    tracedSource([sourcePage(initial, {
      nextCursor: cursor(MODIFIED_A, ids[1]),
      complete: true,
      snapshotComplete: true
    })]),
    { syncKey }
  ));
  assert.deepEqual({ created: second.created, updated: second.updated, unchanged: second.unchanged }, {
    created: 0,
    updated: 0,
    unchanged: 2
  });
  const secondEvents = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: ids,
    afterSequence: 0,
    limit: 100
  });
  assert.equal(secondEvents.events.length, firstEvents.events.length);

  const updated = customerAggregate(ids[0], {
    sourceModifiedAt: MODIFIED_B,
    displayName: `Incrementally updated ${ids[0]}`
  });
  const added = customerAggregate(ids[2], { sourceModifiedAt: MODIFIED_B });
  const incrementalTrace = [];
  const incremental = await runCustomerSync(pool, syncInput(
    "incremental",
    tracedSource([sourcePage([updated, added], {
      nextCursor: cursor(MODIFIED_B, ids[2]),
      complete: true,
      snapshotComplete: true
    })], incrementalTrace),
    { syncKind: "incremental", syncKey }
  ));
  assert.deepEqual({ created: incremental.created, updated: incremental.updated }, {
    created: 1,
    updated: 1
  });
  assert.deepEqual(incrementalTrace[0].cursor, cursor(MODIFIED_A, ids[1]));
  assert.equal((await canonicalRows([ids[0]]))[0].display_name, updated.displayName);
  assert.deepEqual(await aggregateCounts(ids), {
    customers: 3,
    subsidiaries: 3,
    addresses: 3,
    contacts: 3,
    returns_rows: 3
  });
  const state = await syncState(syncKey);
  assert.equal(new Date(state.incremental_cursor_modified_at).toISOString(), MODIFIED_B);
  assert.equal(state.incremental_cursor_external_id, String(ids[2]));
  assert.ok(state.last_incremental_run_id);
  const finalEvents = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: ids,
    afterSequence: 0,
    limit: 100
  });
  assert.equal(finalEvents.events.length, firstEvents.events.length + 2);
});

test("P3-F02: source precedence is deterministic and local site fields survive live hydration", async () => {
  const applyCanonicalCustomerAggregates = requiredFunction(
    syncModule,
    "applyCanonicalCustomerAggregates"
  );
  const csvId = BASE_ID + 40;
  const liveId = BASE_ID + 41;
  const csvV1 = customerAggregate(csvId, {
    sourceKind: "csv_bootstrap",
    sourceModifiedAt: MODIFIED_A,
    sourceVersion: "csv-v1",
    displayName: "CSV version one"
  });
  const csvV2 = customerAggregate(csvId, {
    sourceKind: "csv_bootstrap",
    sourceModifiedAt: MODIFIED_B,
    sourceVersion: "csv-v2",
    displayName: "CSV version two"
  });
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("csv-v1", "csv_bootstrap", [csvV1])
  )).created, 1);
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("csv-v2", "csv_bootstrap", [csvV2])
  )).updated, 1);
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("csv-older", "csv_bootstrap", [csvV1])
  )).ignored, 1);
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("csv-equal-same", "csv_bootstrap", [csvV2])
  )).unchanged, 1);
  const equalDifferent = customerAggregate(csvId, {
    sourceKind: "csv_bootstrap",
    sourceModifiedAt: MODIFIED_B,
    sourceVersion: "csv-v2",
    displayName: "Conflicting equal CSV version"
  });
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("csv-equal-different", "csv_bootstrap", [equalDifferent])
  )).conflicted, 1);
  assert.equal((await canonicalRows([csvId]))[0].display_name, "CSV version two");
  const csvConflict = await query(
    `SELECT count(*)::int AS conflicts
       FROM netsuite_customer_sync_conflicts
      WHERE customer_netsuite_id = $1 AND status = 'open'`,
    [csvId]
  );
  assert.deepEqual(csvConflict.rows[0], { conflicts: 1 });

  const bootstrapLiveId = customerAggregate(liveId, {
    sourceKind: "csv_bootstrap",
    sourceModifiedAt: MODIFIED_C,
    sourceVersion: "csv-newer-clock",
    displayName: "CSV before live observation"
  });
  await applyCanonicalCustomerAggregates(
    pool,
    applyInput("live-id-csv", "csv_bootstrap", [bootstrapLiveId])
  );
  const live = customerAggregate(liveId, {
    sourceKind: "netsuite_read",
    sourceModifiedAt: MODIFIED_A,
    sourceVersion: "netsuite-authoritative",
    displayName: "Live NetSuite wins",
    marker: `live-${liveId}`
  });
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("live-id-hydrate", "netsuite_read", [live])
  )).updated, 1);
  const address = await query(
    `SELECT address_id FROM netsuite_customer_addresses
      WHERE customer_netsuite_id = $1 AND netsuite_address_id = $2`,
    [liveId, `ADDR-${liveId}`]
  );
  assert.equal(address.rowCount, 1);
  const profileId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id, site_instructions,
       gate_code, contact_on_arrival_notes, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      profileId,
      liveId,
      address.rows[0].address_id,
      "Keep this local placement note",
      "LOCAL-GATE",
      "Call the synthetic site contact",
      `p3-customer-admin-${RUN_ID}`
    ]
  );
  const liveRefresh = customerAggregate(liveId, {
    sourceKind: "netsuite_read",
    sourceModifiedAt: MODIFIED_B,
    sourceVersion: "netsuite-authoritative-v2",
    displayName: "Live NetSuite refreshed",
    marker: `live-refresh-${liveId}`
  });
  liveRefresh.addresses[0].netsuiteAddressId = `ADDR-${liveId}`;
  await applyCanonicalCustomerAggregates(
    pool,
    applyInput("live-id-refresh", "netsuite_read", [liveRefresh])
  );
  const retained = await query(
    `SELECT site_instructions, gate_code, contact_on_arrival_notes
       FROM mbt_customer_site_profiles WHERE site_profile_id = $1`,
    [profileId]
  );
  assert.deepEqual(retained.rows[0], {
    site_instructions: "Keep this local placement note",
    gate_code: "LOCAL-GATE",
    contact_on_arrival_notes: "Call the synthetic site contact"
  });
  const lateCsv = customerAggregate(liveId, {
    sourceKind: "csv_bootstrap",
    sourceModifiedAt: "2026-08-04T00:00:00.000Z",
    sourceVersion: "csv-after-live",
    displayName: "CSV must not overwrite live"
  });
  assert.equal((await applyCanonicalCustomerAggregates(
    pool,
    applyInput("live-id-late-csv", "csv_bootstrap", [lateCsv])
  )).conflicted, 1);
  assert.equal((await canonicalRows([liveId]))[0].display_name, "Live NetSuite refreshed");
});

test("P3-F03: empty, partial, malformed, timed-out, and lease-lost full runs preserve snapshots", async () => {
  const runCustomerSync = requiredFunction(syncModule, "runCustomerSync");
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  const ids = [BASE_ID + 60, BASE_ID + 61];
  const syncKey = `p3:${RUN_ID}:failure-preservation`;
  await runCustomerSync(pool, syncInput(
    "failure-seed",
    tracedSource([sourcePage(ids.map((id) => customerAggregate(id)), {
      nextCursor: cursor(MODIFIED_A, ids[1]),
      complete: true,
      snapshotComplete: true
    })]),
    { syncKey }
  ));
  const before = {
    canonical: await canonicalRows(ids),
    counts: await aggregateCounts(ids),
    state: await syncState(syncKey),
    events: await readCustomerMasterEvents(pool, {
      customerNetSuiteIds: ids,
      afterSequence: 0,
      limit: 100
    })
  };

  const failure = (code, message) => Object.assign(new Error(message), { code });
  const attempts = [
    ["empty", "MBT_CUSTOMER_SNAPSHOT_EMPTY", {
      async fetchPage() {
        return sourcePage([], { complete: true, snapshotComplete: true });
      }
    }],
    ["partial", "MBT_CUSTOMER_SNAPSHOT_INCOMPLETE", {
      async fetchPage() {
        return sourcePage([customerAggregate(ids[0])], {
          complete: true,
          snapshotComplete: false
        });
      }
    }],
    ["malformed", "MBT_CUSTOMER_SOURCE_INVALID", {
      async fetchPage() {
        return { records: "not-an-array", complete: true, snapshotComplete: true };
      }
    }],
    ["timeout", "MBT_CUSTOMER_SOURCE_TIMEOUT", {
      async fetchPage() {
        throw failure("MBT_CUSTOMER_SOURCE_TIMEOUT", "Synthetic source timeout.");
      }
    }],
    ["lease-lost", "MBT_CUSTOMER_SYNC_LEASE_LOST", {
      async fetchPage() {
        throw failure("MBT_CUSTOMER_SYNC_LEASE_LOST", "Synthetic lease loss.");
      }
    }]
  ];
  for (const [label, code, source] of attempts) {
    await assert.rejects(
      runCustomerSync(pool, syncInput(`failure-${label}`, source, { syncKey })),
      (error) => error?.code === code,
      label
    );
    assert.deepEqual(await canonicalRows(ids), before.canonical, label);
    assert.deepEqual(await aggregateCounts(ids), before.counts, label);
    assert.deepEqual(await syncState(syncKey), before.state, label);
    assert.deepEqual(await readCustomerMasterEvents(pool, {
      customerNetSuiteIds: ids,
      afterSequence: 0,
      limit: 100
    }), before.events, label);
  }
});

test("P3-F07: CSV bootstrap uses the canonical boundary and live NetSuite later supersedes it", async () => {
  const applyCanonicalCustomerAggregates = requiredFunction(
    syncModule,
    "applyCanonicalCustomerAggregates"
  );
  const readCustomerProvenance = requiredFunction(syncModule, "readCustomerProvenance");
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  const id = BASE_ID + 80;
  const csv = customerAggregate(id, {
    sourceKind: "csv_bootstrap",
    sourceModifiedAt: MODIFIED_B,
    sourceVersion: `workbook-${"a".repeat(64)}`,
    displayName: "CSV bootstrap customer"
  });
  const command = applyInput("bootstrap-canonical", "csv_bootstrap", [csv]);
  const first = await applyCanonicalCustomerAggregates(pool, command);
  const replay = await applyCanonicalCustomerAggregates(pool, structuredClone(command));
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.deepEqual(await aggregateCounts([id]), {
    customers: 1,
    subsidiaries: 1,
    addresses: 1,
    contacts: 1,
    returns_rows: 1
  });
  assert.deepEqual(await readCustomerProvenance(pool, id), {
    customerNetSuiteId: id,
    sourceKind: "csv_bootstrap",
    sourceAccountId: `P3_SYNTH_${RUN_ID}`,
    sourceVersion: csv.sourceVersion,
    lastLiveNetSuiteObservationAt: null
  });
  const beforeLiveEvents = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: [id],
    afterSequence: 0,
    limit: 100
  });
  assert.equal(beforeLiveEvents.events.length, 1);

  const live = customerAggregate(id, {
    sourceKind: "netsuite_read",
    sourceModifiedAt: MODIFIED_A,
    sourceVersion: "live-hydration-v1",
    displayName: "Hydrated from live NetSuite"
  });
  const hydrated = await applyCanonicalCustomerAggregates(
    pool,
    applyInput("bootstrap-live-hydration", "netsuite_read", [live])
  );
  assert.equal(hydrated.updated, 1);
  assert.equal((await canonicalRows([id]))[0].display_name, live.displayName);
  const provenance = await readCustomerProvenance(pool, id);
  assert.equal(provenance.sourceKind, "netsuite_read");
  assert.equal(provenance.sourceVersion, live.sourceVersion);
  assert.equal(Number.isNaN(new Date(provenance.lastLiveNetSuiteObservationAt).getTime()), false);
  const afterLiveEvents = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: [id],
    afterSequence: 0,
    limit: 100
  });
  assert.equal(afterLiveEvents.events.length, 2);
});
