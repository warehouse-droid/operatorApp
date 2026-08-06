import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access } from "node:fs/promises";
import test, { after } from "node:test";

import { closeDb, pool, query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const BASE_ID = 100_000_000 + Number.parseInt(RUN_ID.slice(0, 6), 16);
const BASE_SUBSIDIARY_ID = 90_000_000 + Number.parseInt(RUN_ID.slice(6, 12), 16);
const RACE_REPETITIONS = 25;
const MODIFIED_AT = "2026-08-03T14:00:00.000Z";

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

function aggregate(netsuiteId, {
  accountId,
  subsidiaryId,
  displayName = `Race customer ${netsuiteId}`,
  payloadHash = null
} = {}) {
  const value = {
    netsuiteId,
    entityNumber: String(netsuiteId),
    legalName: displayName,
    displayName,
    currency: "CAD",
    terms: "NET30",
    taxStatus: "taxable",
    creditStatus: "good",
    email: `race-${netsuiteId}@example.invalid`,
    phone: "5550000000",
    active: true,
    sourceKind: "netsuite_read",
    sourceAccountId: accountId,
    sourceModifiedAt: MODIFIED_AT,
    sourceVersion: `race-v1-${netsuiteId}`,
    subsidiaries: [{
      netsuiteId: subsidiaryId,
      relationshipName: "Synthetic race subsidiary",
      primary: true,
      active: true,
      sourceModifiedAt: MODIFIED_AT,
      sourceVersion: `race-v1-${netsuiteId}-subsidiary`
    }],
    addresses: [{
      netsuiteAddressId: `RACE-ADDR-${netsuiteId}`,
      label: "Race site",
      shippingDefault: true,
      billingDefault: false,
      addressee: displayName,
      addressLine1: "1 Race Route",
      city: "Fixtureville",
      region: "ON",
      postalCode: "A1A 1A1",
      countryCode: "CA",
      active: true,
      sourceModifiedAt: MODIFIED_AT,
      sourceVersion: `race-v1-${netsuiteId}-address`
    }],
    contacts: []
  };
  return { ...value, payloadHash: payloadHash || hash(value) };
}

function syncCommand(iteration, source) {
  const accountId = `P3_RACE_ACCOUNT_${RUN_ID}_${iteration}`;
  const subsidiaryId = BASE_SUBSIDIARY_ID + iteration;
  return {
    syncKey: `p3:race:${RUN_ID}:${iteration}`,
    accountId,
    subsidiaryId,
    syncKind: "full_reconciliation",
    sourceKind: "netsuite_read",
    correlationId: `p3-race-sync-${RUN_ID}-${iteration}`,
    requestedBy: `p3-race-admin-${RUN_ID}`,
    pageSize: 100,
    source
  };
}

function applyCommand(iteration, side, customer) {
  return {
    accountId: customer.sourceAccountId,
    subsidiaryId: customer.subsidiaries[0].netsuiteId,
    sourceKind: "netsuite_read",
    sourceAsOf: MODIFIED_AT,
    sourceVersion: customer.sourceVersion,
    aggregates: [customer],
    correlationId: `p3-race-apply-${RUN_ID}-${iteration}-${side}`,
    idempotencyKey: `p3-race-idem-${RUN_ID}-${iteration}-${side}`,
    actorId: `p3-race-admin-${RUN_ID}`
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
}

async function within(promise, milliseconds, label) {
  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms.`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

after(async () => {
  await closeDb();
});

test("P3-F01 concurrency: one durable lease owns each account/subsidiary sync", {
  timeout: 120_000
}, async () => {
  const runCustomerSync = requiredFunction(syncModule, "runCustomerSync");
  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const entered = deferred();
    const release = deferred();
    const accountId = `P3_RACE_ACCOUNT_${RUN_ID}_${iteration}`;
    const subsidiaryId = BASE_SUBSIDIARY_ID + iteration;
    const id = BASE_ID + iteration;
    let winnerFetches = 0;
    const winnerSource = {
      async fetchPage() {
        winnerFetches += 1;
        entered.resolve();
        await release.promise;
        return {
          records: [aggregate(id, { accountId, subsidiaryId })],
          nextCursor: { modifiedAt: MODIFIED_AT, internalId: id },
          complete: true,
          snapshotComplete: true
        };
      }
    };
    const winner = runCustomerSync(pool, syncCommand(iteration, winnerSource));
    await within(entered.promise, 2_000, `winner ${iteration} lease claim`);
    let competitorFetches = 0;
    const competitors = Array.from({ length: 4 }, (_unused, worker) => runCustomerSync(
      pool,
      {
        ...syncCommand(iteration, {
          async fetchPage() {
            competitorFetches += 1;
            throw new Error("A losing sync claimant must not read the source.");
          }
        }),
        correlationId: `p3-race-sync-${RUN_ID}-${iteration}-competitor-${worker}`
      }
    ));
    let blocked;
    try {
      blocked = await within(
        Promise.all(competitors),
        2_000,
        `competitors ${iteration} bounded lease decision`
      );
    } finally {
      release.resolve();
    }
    const completed = await winner;
    assert.equal(completed.status, "completed");
    assert.equal(winnerFetches, 1);
    assert.equal(competitorFetches, 0);
    assert.deepEqual(blocked.map(({ skipped, reason }) => ({ skipped, reason })), [
      { skipped: true, reason: "customer_sync_already_running" },
      { skipped: true, reason: "customer_sync_already_running" },
      { skipped: true, reason: "customer_sync_already_running" },
      { skipped: true, reason: "customer_sync_already_running" }
    ]);
    const active = await query(
      `SELECT count(*)::int AS active
         FROM netsuite_customer_sync_runs
        WHERE account_id = $1
          AND subsidiary_id = $2
          AND status IN ('pending', 'running')`,
      [accountId, subsidiaryId]
    );
    assert.deepEqual(active.rows[0], { active: 0 });
  }
});

test("P3-F02 concurrency: equal-version competing payloads commit one value and one conflict", {
  timeout: 120_000
}, async () => {
  const applyCanonicalCustomerAggregates = requiredFunction(
    syncModule,
    "applyCanonicalCustomerAggregates"
  );
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  for (let iteration = 0; iteration < RACE_REPETITIONS; iteration += 1) {
    const id = BASE_ID + 1_000 + iteration;
    const accountId = `P3_RACE_APPLY_${RUN_ID}_${iteration}`;
    const subsidiaryId = BASE_SUBSIDIARY_ID + 1_000 + iteration;
    const left = aggregate(id, {
      accountId,
      subsidiaryId,
      displayName: `Race left ${iteration}`,
      payloadHash: "a".repeat(64)
    });
    const right = aggregate(id, {
      accountId,
      subsidiaryId,
      displayName: `Race right ${iteration}`,
      payloadHash: "b".repeat(64)
    });
    const outcomes = await Promise.all([
      applyCanonicalCustomerAggregates(pool, applyCommand(iteration, "left", left)),
      applyCanonicalCustomerAggregates(pool, applyCommand(iteration, "right", right))
    ]);
    assert.deepEqual(
      outcomes.map(({ created, conflicted }) => ({ created, conflicted })).sort((a, b) => b.created - a.created),
      [{ created: 1, conflicted: 0 }, { created: 0, conflicted: 1 }]
    );
    const evidence = await query(
      `SELECT
         (SELECT count(*)::int FROM netsuite_customers
           WHERE netsuite_id = $1) AS customers,
         (SELECT count(*)::int FROM netsuite_customer_sync_conflicts
           WHERE customer_netsuite_id = $1 AND status = 'open') AS conflicts,
         (SELECT count(*)::int FROM return_customer_directory
           WHERE netsuite_customer_id = $1) AS returns_rows,
         (SELECT display_name FROM netsuite_customers
           WHERE netsuite_id = $1) AS display_name,
         (SELECT display_name FROM return_customer_directory
           WHERE netsuite_customer_id = $1) AS returns_name`,
      [id]
    );
    assert.equal(evidence.rows[0].customers, 1);
    assert.equal(evidence.rows[0].conflicts, 1);
    assert.equal(evidence.rows[0].returns_rows, 1);
    assert.ok([left.displayName, right.displayName].includes(evidence.rows[0].display_name));
    assert.equal(evidence.rows[0].returns_name, evidence.rows[0].display_name);
    const events = await readCustomerMasterEvents(pool, {
      customerNetSuiteIds: [id],
      afterSequence: 0,
      limit: 10
    });
    assert.equal(events.events.length, 1);
  }
});

test("P3-F03 concurrency: failure after canonical write rolls back projection, event, cursor, and receipt", async () => {
  const applyCanonicalCustomerAggregates = requiredFunction(
    syncModule,
    "applyCanonicalCustomerAggregates"
  );
  const readCustomerMasterEvents = requiredFunction(
    contractModule,
    "readCustomerMasterEvents"
  );
  const id = BASE_ID + 2_000;
  const accountId = `P3_RACE_ROLLBACK_${RUN_ID}`;
  const subsidiaryId = BASE_SUBSIDIARY_ID + 2_000;
  const customer = aggregate(id, { accountId, subsidiaryId });
  const command = {
    ...applyCommand("rollback", "fault", customer),
    hooks: {
      async afterCanonicalApply() {
        throw new Error("P3_SYNTHETIC_AFTER_CANONICAL_FAILURE");
      }
    }
  };
  await assert.rejects(
    applyCanonicalCustomerAggregates(pool, command),
    /P3_SYNTHETIC_AFTER_CANONICAL_FAILURE/
  );
  const evidence = await query(
    `SELECT
       (SELECT count(*)::int FROM netsuite_customers
         WHERE netsuite_id = $1) AS customers,
       (SELECT count(*)::int FROM netsuite_customer_subsidiaries
         WHERE customer_netsuite_id = $1) AS subsidiaries,
       (SELECT count(*)::int FROM netsuite_customer_addresses
         WHERE customer_netsuite_id = $1) AS addresses,
       (SELECT count(*)::int FROM return_customer_directory
         WHERE netsuite_customer_id = $1) AS returns_rows,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE idempotency_key = $2) AS receipts`,
    [id, command.idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], {
    customers: 0,
    subsidiaries: 0,
    addresses: 0,
    returns_rows: 0,
    receipts: 0
  });
  const events = await readCustomerMasterEvents(pool, {
    customerNetSuiteIds: [id],
    afterSequence: 0,
    limit: 10
  });
  assert.deepEqual(events.events, []);
});
