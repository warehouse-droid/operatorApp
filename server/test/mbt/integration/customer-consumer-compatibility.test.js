import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access } from "node:fs/promises";
import test, { after } from "node:test";

import { closeDb, pool, query } from "../../../src/db.js";
import {
  normalizeReturnCustomerDirectoryEntry,
  searchLocalReturnCustomerDirectory
} from "../../../src/return-customer-directory.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const BASE_ID = 120_000_000 + Number.parseInt(RUN_ID.slice(0, 6), 16);
const SUBSIDIARY_ID = 110_000_000 + Number.parseInt(RUN_ID.slice(6, 12), 16);
const ACCOUNT_ID = `P3_CONSUMER_${RUN_ID}`;
const MODIFIED_AT = "2026-08-03T16:00:00.000Z";
const SHARED_SECRET = `p3-customer-master-secret-${RUN_ID}`;

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

const syncModule = await optionalModule("../../../src/mbt/customer-sync-service.js");
const contractModule = await optionalModule("../../../src/mbt/customer-master-contract.js");
const projectionModule = await optionalModule("../../../src/mbt/return-customer-projection.js");

function requiredFunction(module, name) {
  assert.equal(
    typeof module[name],
    "function",
    `P3.3 requires the production export ${name}; this is the intended RED boundary.`
  );
  return module[name];
}

function requiredValue(module, name, expected) {
  assert.equal(
    module[name],
    expected,
    `P3.3 requires ${name} to remain the independently versioned ${expected} contract.`
  );
  return module[name];
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function aggregate(netsuiteId, overrides = {}) {
  const marker = overrides.marker || `consumer-${netsuiteId}`;
  const sourceModifiedAt = overrides.sourceModifiedAt || MODIFIED_AT;
  const sourceVersion = overrides.sourceVersion || `consumer-v1-${netsuiteId}`;
  const value = {
    netsuiteId,
    entityNumber: overrides.entityNumber || String(netsuiteId),
    legalName: overrides.legalName || `Synthetic Company ${marker}`,
    displayName: overrides.displayName || `Synthetic Customer ${marker}`,
    currency: "CAD",
    terms: "NET30",
    taxStatus: "taxable",
    creditStatus: "good",
    email: `${marker}@example.invalid`,
    phone: "5195550100",
    active: overrides.active ?? true,
    sourceKind: overrides.sourceKind || "customer_master_event",
    sourceAccountId: ACCOUNT_ID,
    sourceModifiedAt,
    sourceVersion,
    subsidiaries: [{
      netsuiteId: SUBSIDIARY_ID,
      relationshipName: "Synthetic MBT consumer",
      primary: true,
      active: true,
      sourceModifiedAt,
      sourceVersion: `${sourceVersion}-subsidiary`
    }],
    addresses: [{
      netsuiteAddressId: `CONSUMER-ADDR-${netsuiteId}`,
      label: "Primary service site",
      shippingDefault: true,
      billingDefault: false,
      addressee: `Synthetic Company ${marker}`,
      addressLine1: `${netsuiteId % 1000} Consumer Road`,
      addressLine2: "Unit T",
      city: "Fixtureville",
      region: "ON",
      postalCode: "N0N 0N0",
      countryCode: "CA",
      phone: "5195550101",
      active: true,
      sourceModifiedAt,
      sourceVersion: `${sourceVersion}-address`
    }],
    contacts: []
  };
  return { ...value, payloadHash: overrides.payloadHash || digest(value) };
}

function applyCommand(label, customers) {
  return {
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID,
    sourceKind: customers[0].sourceKind,
    sourceAsOf: MODIFIED_AT,
    sourceVersion: `compatibility-${label}`,
    aggregates: customers,
    correlationId: `p3-compat-${RUN_ID}-${label}`,
    idempotencyKey: `p3-compat-idem-${RUN_ID}-${label}`,
    actorId: `p3-compat-admin-${RUN_ID}`
  };
}

async function mirrorV1State() {
  const result = await query(
    `SELECT
       (SELECT last_sequence::text FROM netsuite_mirror_sequence
         WHERE singleton_id = 1) AS last_sequence,
       (SELECT count(*)::int FROM netsuite_mirror_events) AS events,
       (SELECT count(*)::int FROM netsuite_mirror_inbox) AS inbox,
       (SELECT md5(COALESCE(jsonb_agg(jsonb_build_object(
          'key', state_key, 'value', state_value
        ) ORDER BY state_key), '[]'::jsonb)::text)
          FROM netsuite_mirror_state) AS state_hash`
  );
  return result.rows[0];
}

async function canonicalCustomer(id) {
  const result = await query(
    `SELECT netsuite_id::text AS netsuite_id, entity_number, legal_name,
            display_name, active, source_version, payload_hash
       FROM netsuite_customers WHERE netsuite_id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

after(async () => {
  await closeDb();
});

test("P3-F04: customer-master/v1 is durable and independent from netsuite-mirror/v1", async () => {
  requiredValue(contractModule, "CUSTOMER_MASTER_CONTRACT", "customer-master/v1");
  const applyCanonicalCustomerAggregates = requiredFunction(
    syncModule,
    "applyCanonicalCustomerAggregates"
  );
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  const id = BASE_ID + 1;
  const before = await mirrorV1State();
  const customer = aggregate(id, { sourceKind: "netsuite_read" });
  const result = await applyCanonicalCustomerAggregates(
    pool,
    applyCommand("independent-v1", [customer])
  );
  assert.equal(result.created, 1);
  const customerEvents = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: [id],
    afterSequence: 0,
    limit: 10
  });
  assert.equal(customerEvents.contract, "customer-master/v1");
  assert.equal(customerEvents.events.length, 1);
  assert.equal(customerEvents.events[0].customerNetSuiteId, id);
  assert.deepEqual(await mirrorV1State(), before);
  await assert.rejects(
    query(
      `INSERT INTO netsuite_mirror_events (
         sequence_id, event_uuid, entity_type, entity_id, change_type, source, payload
       ) VALUES (
         (SELECT last_sequence + 1000000 FROM netsuite_mirror_sequence WHERE singleton_id = 1),
         $1, 'customer', $2, 'upsert', 'p3-negative-contract', '{}'::jsonb
       )`,
      [crypto.randomUUID(), String(id)]
    ),
    (error) => error?.code === "23514"
  );
  assert.deepEqual(await mirrorV1State(), before);
});

test("P3-F04: a signed event replay and bounded snapshot reconcile without direct NetSuite access", async () => {
  const signCustomerMasterEnvelope = requiredFunction(
    contractModule,
    "signCustomerMasterEnvelope"
  );
  const createCustomerMasterEventEnvelope = requiredFunction(
    contractModule,
    "createCustomerMasterEventEnvelope"
  );
  const acceptCustomerMasterEventEnvelope = requiredFunction(
    contractModule,
    "acceptCustomerMasterEventEnvelope"
  );
  const createCustomerMasterSnapshotEnvelope = requiredFunction(
    contractModule,
    "createCustomerMasterSnapshotEnvelope"
  );
  const acceptCustomerMasterSnapshotEnvelope = requiredFunction(
    contractModule,
    "acceptCustomerMasterSnapshotEnvelope"
  );
  const readCustomerMasterConsumerState = requiredFunction(
    contractModule,
    "readCustomerMasterConsumerState"
  );
  const ids = [BASE_ID + 20, BASE_ID + 21, BASE_ID + 22];
  const events = ids.slice(0, 2).map((id, index) => ({
    sequence: 9_000_000 + Number.parseInt(RUN_ID.slice(0, 5), 16) + index,
    eventId: crypto.randomUUID(),
    changeType: "upsert",
    customerNetSuiteId: id,
    aggregate: aggregate(id),
    committedAt: new Date(Date.parse(MODIFIED_AT) + index).toISOString()
  }));
  const eventEnvelope = createCustomerMasterEventEnvelope({
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID,
    events,
    afterSequence: events[0].sequence - 1,
    maxEvents: 2
  });
  assert.equal(eventEnvelope.contract, "customer-master/v1");
  assert.equal(eventEnvelope.events.length, 2);
  const eventSignature = signCustomerMasterEnvelope({
    secret: SHARED_SECRET,
    envelope: eventEnvelope
  });
  let directNetSuiteCalls = 0;
  let transportMutationCalls = 0;
  const consumerBoundary = {
    directNetSuite: {
      async fetchCustomers() {
        directNetSuiteCalls += 1;
        throw new Error("A customer-master consumer must never call NetSuite.");
      }
    },
    transport: {
      async mutate() {
        transportMutationCalls += 1;
        throw new Error("Customer reconciliation must not mutate a remote transport.");
      }
    }
  };
  const first = await acceptCustomerMasterEventEnvelope(pool, {
    envelope: eventEnvelope,
    signature: eventSignature,
    secret: SHARED_SECRET,
    consumerId: `p3-consumer-${RUN_ID}`,
    ...consumerBoundary
  });
  const replay = await acceptCustomerMasterEventEnvelope(pool, {
    envelope: structuredClone(eventEnvelope),
    signature: eventSignature,
    secret: SHARED_SECRET,
    consumerId: `p3-consumer-${RUN_ID}`,
    ...consumerBoundary
  });
  assert.equal(first.accepted, 2);
  assert.equal(first.replayed, false);
  assert.equal(replay.accepted, 0);
  assert.equal(replay.replayed, true);
  assert.equal(directNetSuiteCalls, 0);
  assert.equal(transportMutationCalls, 0);
  assert.ok(await canonicalCustomer(ids[0]));
  assert.ok(await canonicalCustomer(ids[1]));

  const snapshotCustomers = ids.map((id) => aggregate(id, {
    sourceVersion: `snapshot-${id}`,
    sourceModifiedAt: "2026-08-03T17:00:00.000Z"
  }));
  const firstPage = createCustomerMasterSnapshotEnvelope({
    snapshotId: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID,
    customers: snapshotCustomers,
    cursor: null,
    maxRecords: 2
  });
  assert.equal(firstPage.contract, "customer-master/v1");
  assert.equal(firstPage.customers.length, 2);
  assert.equal(firstPage.complete, false);
  assert.ok(firstPage.nextCursor);
  const secondPage = createCustomerMasterSnapshotEnvelope({
    snapshotId: firstPage.snapshotId,
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID,
    customers: snapshotCustomers,
    cursor: firstPage.nextCursor,
    maxRecords: 2
  });
  assert.equal(secondPage.customers.length, 1);
  assert.equal(secondPage.complete, true);
  for (const page of [firstPage, secondPage]) {
    await acceptCustomerMasterSnapshotEnvelope(pool, {
      envelope: page,
      signature: signCustomerMasterEnvelope({ secret: SHARED_SECRET, envelope: page }),
      secret: SHARED_SECRET,
      consumerId: `p3-consumer-${RUN_ID}`,
      ...consumerBoundary
    });
  }
  assert.equal(directNetSuiteCalls, 0);
  assert.equal(transportMutationCalls, 0);
  assert.ok(await canonicalCustomer(ids[2]));
  const state = await readCustomerMasterConsumerState(pool, {
    consumerId: `p3-consumer-${RUN_ID}`,
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID
  });
  assert.equal(state.contract, "customer-master/v1");
  assert.equal(state.highWaterSequence, events[1].sequence);
  assert.equal(state.lastCompleteSnapshotId, firstPage.snapshotId);
});

test("P3-F05: canonical projection preserves the exact Returns shape, ordering, and parity by internal ID", async () => {
  const projectCanonicalCustomerForReturns = requiredFunction(
    projectionModule,
    "projectCanonicalCustomerForReturns"
  );
  const applyCanonicalReturnsProjection = requiredFunction(
    projectionModule,
    "applyCanonicalReturnsProjection"
  );
  const compareReturnProjectionParity = requiredFunction(
    projectionModule,
    "compareReturnProjectionParity"
  );
  const ids = [BASE_ID + 40, BASE_ID + 41, BASE_ID + 42];
  const activeCustomers = [
    aggregate(ids[0], {
      entityNumber: `B${ids[0]}`,
      legalName: "Synthetic Beta Company",
      displayName: "Synthetic Beta Display",
      marker: "beta"
    }),
    aggregate(ids[1], {
      entityNumber: `A${ids[1]}`,
      legalName: "Synthetic Alpha Company",
      displayName: "Synthetic Alpha Display",
      marker: "alpha"
    })
  ];
  const inactive = aggregate(ids[2], { active: false, marker: "inactive" });
  const projected = activeCustomers.map(projectCanonicalCustomerForReturns);
  assert.deepEqual(Object.keys(projected[0]), [
    "id",
    "internalId",
    "code",
    "entityId",
    "name",
    "companyName",
    "phone",
    "address"
  ]);
  assert.deepEqual(projected[0], normalizeReturnCustomerDirectoryEntry({
    internalId: ids[0],
    entityId: `B${ids[0]}`,
    companyName: "Synthetic Beta Company",
    name: "Synthetic Beta Display",
    phone: "5195550100",
    address: `${ids[0] % 1000} Consumer Road, Unit T, Fixtureville, ON N0N 0N0, CA`
  }));
  assert.equal(projectCanonicalCustomerForReturns(inactive), null);

  await applyCanonicalReturnsProjection(pool, {
    generationId: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    subsidiaryId: SUBSIDIARY_ID,
    customers: [...activeCustomers, inactive],
    source: "canonical_customer_master",
    actorId: `p3-compat-admin-${RUN_ID}`
  });
  assert.deepEqual(
    await searchLocalReturnCustomerDirectory("Synthetic", { limit: 10 }),
    [projected[1], projected[0]],
    "The established Returns search result order and public fields must not change."
  );
  const inactiveProjection = await query(
    "SELECT count(*)::int AS rows FROM return_customer_directory WHERE netsuite_customer_id = $1",
    [ids[2]]
  );
  assert.deepEqual(inactiveProjection.rows[0], { rows: 0 });
  const parity = compareReturnProjectionParity({
    canonicalCustomers: [...activeCustomers, inactive],
    returnCustomers: projected
  });
  assert.equal(parity.matches, true);
  assert.equal(parity.canonicalActiveCount, 2);
  assert.equal(parity.returnCount, 2);
  assert.deepEqual(parity.missingInternalIds, []);
  assert.deepEqual(parity.extraInternalIds, []);
  assert.deepEqual(parity.mismatchedInternalIds, []);
  assert.match(parity.canonicalHash, /^[0-9a-f]{64}$/);
  assert.equal(parity.returnHash, parity.canonicalHash);
});

test("P3-F05: Returns cutover admits exactly one writer and retains an explicit rollback path", () => {
  const evaluateReturnsProjectionOwnership = requiredFunction(
    projectionModule,
    "evaluateReturnsProjectionOwnership"
  );
  assert.deepEqual(evaluateReturnsProjectionOwnership({
    mode: "legacy",
    canonicalFresh: false,
    parityMatches: false,
    legacySchedulerEnabled: true
  }), {
    allowed: true,
    activeWriter: "legacy_direct_refresh",
    canonicalProjectionTarget: "shadow",
    legacySchedulerEnabled: true
  });
  assert.deepEqual(evaluateReturnsProjectionOwnership({
    mode: "cutover",
    canonicalFresh: true,
    parityMatches: true,
    legacySchedulerEnabled: true
  }), {
    allowed: false,
    reason: "legacy_writer_still_enabled"
  });
  assert.deepEqual(evaluateReturnsProjectionOwnership({
    mode: "cutover",
    canonicalFresh: false,
    parityMatches: true,
    legacySchedulerEnabled: false
  }), {
    allowed: false,
    reason: "canonical_projection_not_fresh"
  });
  assert.deepEqual(evaluateReturnsProjectionOwnership({
    mode: "cutover",
    canonicalFresh: true,
    parityMatches: false,
    legacySchedulerEnabled: false
  }), {
    allowed: false,
    reason: "returns_parity_not_met"
  });
  assert.deepEqual(evaluateReturnsProjectionOwnership({
    mode: "cutover",
    canonicalFresh: true,
    parityMatches: true,
    legacySchedulerEnabled: false
  }), {
    allowed: true,
    activeWriter: "canonical_projection",
    canonicalProjectionTarget: "return_customer_directory",
    legacySchedulerEnabled: false
  });
  assert.deepEqual(evaluateReturnsProjectionOwnership({
    mode: "rollback",
    canonicalFresh: true,
    parityMatches: false,
    legacySchedulerEnabled: true
  }), {
    allowed: true,
    activeWriter: "legacy_direct_refresh",
    canonicalProjectionTarget: "shadow",
    legacySchedulerEnabled: true
  });
});
