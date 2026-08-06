import assert from "node:assert/strict";
import test from "node:test";

const ACCOUNT_ID = "P3-UNIT-ACCOUNT";
const CONSUMER_ID = "p3-unit-consumer";
const SECRET = "p3-unit-customer-master-secret";
const SNAPSHOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_IDS = Object.freeze([
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333"
]);

function futureContract() {
  return import("../../../src/mbt/customer-master-contract.js");
}

function event(sequence, index = 0, overrides = {}) {
  const customerNetSuiteId = overrides.customerNetSuiteId ?? sequence + 100;
  return {
    sequence,
    eventId: EVENT_IDS[index],
    changeType: "upsert",
    customerNetSuiteId,
    aggregate: {
      netsuiteId: customerNetSuiteId,
      displayName: `Customer ${customerNetSuiteId}`
    },
    committedAt: `2026-08-0${index + 1}T12:34:56-04:00`,
    ...overrides
  };
}

/** @param {unknown} error @param {string} message */
function exactTypeError(error, message) {
  return error instanceof TypeError && error.message === message;
}

/** @param {unknown} error @param {string} code @param {number} status */
function exactMbtError(error, code, status) {
  return Boolean(error && typeof error === "object"
    && error.name === "MbtError"
    && error.code === code
    && error.status === status);
}

test("P3-F04 contract: event pages are canonical, bounded, and leave source evidence immutable", async () => {
  const { createCustomerMasterEventEnvelope, CUSTOMER_MASTER_CONTRACT } = await futureContract();
  const source = [
    event(3, 2),
    event(1, 0),
    event(2, 1, {
      customerNetSuiteId: "9007199254740993",
      aggregate: { netsuiteId: "9007199254740993", displayName: "Large identity" }
    })
  ];
  const before = structuredClone(source);

  const envelope = createCustomerMasterEventEnvelope({
    accountId: `  ${ACCOUNT_ID}  `,
    subsidiaryId: null,
    events: source,
    afterSequence: "0001",
    maxEvents: 1
  });

  assert.equal(envelope.contract, CUSTOMER_MASTER_CONTRACT);
  assert.equal(envelope.accountId, ACCOUNT_ID);
  assert.equal(envelope.subsidiaryId, null);
  assert.equal(envelope.afterSequence, 1);
  assert.equal(envelope.nextSequence, 2);
  assert.deepEqual(envelope.events.map(({ sequence }) => sequence), [2]);
  assert.equal(envelope.events[0].customerNetSuiteId, "9007199254740993");
  assert.equal(envelope.events[0].committedAt, "2026-08-02T16:34:56.000Z");
  assert.deepEqual(source, before, "canonical paging must not sort or normalize caller-owned evidence");
});

test("P3-F04 contract: hostile event fields fail closed with exact boundary errors", async (t) => {
  const { createCustomerMasterEventEnvelope } = await futureContract();
  const valid = { accountId: ACCOUNT_ID, events: [event(1)] };
  const cases = [
    ["events collection", { ...valid, events: {} }, "Customer master events must be an array."],
    ["event record", { ...valid, events: [null] }, "Customer master events entry must be an object."],
    ["change type", { ...valid, events: [event(1, 0, { changeType: "delete" })] }, "Customer master event change type is not supported."],
    ["zero sequence", { ...valid, events: [event(0)] }, "Customer master event sequence must be a positive integer."],
    ["fractional numeric sequence", { ...valid, events: [event(1.5)] }, "Customer master event sequence must be a positive integer."],
    ["unsafe numeric sequence", { ...valid, events: [event(Number.MAX_SAFE_INTEGER + 1)] }, "Customer master event sequence must be a positive integer."],
    ["bigint overflow", { ...valid, events: [event("9223372036854775808")] }, "Customer master event sequence exceeds the PostgreSQL bigint range."],
    ["event UUID", { ...valid, events: [event(1, 0, { eventId: "not-a-uuid" })] }, "Customer master event ID must be a UUID."],
    ["customer identity", { ...valid, events: [event(1, 0, { customerNetSuiteId: -4 })] }, "Customer master event customer ID must be a positive integer."],
    ["unsafe numeric customer identity", { ...valid, events: [event(1, 0, { customerNetSuiteId: Number.MAX_SAFE_INTEGER + 1 })] }, "Customer master event customer ID must be a positive integer."],
    ["aggregate", { ...valid, events: [event(1, 0, { aggregate: [] })] }, "Customer master event aggregate 1 must be an object."],
    ["timestamp", { ...valid, events: [event(1, 0, { committedAt: "not-a-date" })] }, "Customer master event committed time must be a valid timestamp."],
    ["cursor", { ...valid, afterSequence: -1 }, "Customer master event cursor must be a nonnegative integer."],
    ["unsafe numeric cursor", { ...valid, afterSequence: Number.MAX_SAFE_INTEGER + 1 }, "Customer master event cursor must be a nonnegative integer."],
    ["event bound", { ...valid, maxEvents: 0 }, "Customer master event bound must be a positive integer."],
    ["account", { ...valid, accountId: "  " }, "Customer master account ID is required."],
    ["subsidiary", { ...valid, subsidiaryId: "0" }, "Customer master subsidiary ID must be a positive integer."]
  ];

  for (const [name, input, message] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => createCustomerMasterEventEnvelope(input),
        (error) => exactTypeError(error, message)
      );
    });
  }
});

test("P3-F04 contract: event reads deduplicate scope, cap queries, and preserve bigint identities", async () => {
  const { readCustomerMasterEvents, CUSTOMER_MASTER_CONTRACT } = await futureContract();
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          sequence_id: "9007199254740993",
          event_uuid: EVENT_IDS[0],
          change_type: "inactivate",
          customer_netsuite_id: "9007199254740994",
          aggregate_payload: { netsuiteId: "9007199254740994", active: false },
          committed_at: "2026-08-04T08:00:00-04:00"
        }]
      };
    }
  };

  const empty = await readCustomerMasterEvents(database);
  assert.deepEqual(empty, { contract: CUSTOMER_MASTER_CONTRACT, events: [] });
  assert.equal(calls.length, 0, "an unscoped event read must not touch the database");

  const result = await readCustomerMasterEvents(database, {
    customerNetSuiteIds: ["7", 7, "8"],
    afterSequence: "0009",
    limit: 50_000
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [["7", "8"], "9", 1000]);
  assert.match(calls[0].sql, /customer_netsuite_id = ANY\(\$1::bigint\[\]\)/u);
  assert.deepEqual(result, {
    contract: CUSTOMER_MASTER_CONTRACT,
    events: [{
      sequence: "9007199254740993",
      eventId: EVENT_IDS[0],
      changeType: "inactivate",
      customerNetSuiteId: "9007199254740994",
      aggregate: { netsuiteId: "9007199254740994", active: false },
      committedAt: "2026-08-04T12:00:00.000Z"
    }]
  });
});

test("P3-F04 contract: signature rejection happens before any database access", async () => {
  const {
    acceptCustomerMasterEventEnvelope,
    createCustomerMasterEventEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterEventEnvelope({ accountId: ACCOUNT_ID, events: [event(1)] });
  let queries = 0;
  const database = { async query() { queries += 1; return { rows: [] }; } };

  assert.throws(
    () => signCustomerMasterEnvelope({ secret: "   ", envelope }),
    (error) => exactTypeError(error, "Customer master shared secret is required.")
  );
  for (const signature of ["f".repeat(63), "0".repeat(64)]) {
    await assert.rejects(
      acceptCustomerMasterEventEnvelope(database, {
        envelope,
        signature,
        secret: SECRET,
        consumerId: CONSUMER_ID
      }),
      (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_SIGNATURE_INVALID", 401)
    );
  }
  assert.equal(queries, 0);
});

test("P3-F04 contract: exact event replays are read-only and identity reuse is rejected", async () => {
  const {
    acceptCustomerMasterEventEnvelope,
    createCustomerMasterEventEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterEventEnvelope({
    accountId: ACCOUNT_ID,
    subsidiaryId: 77,
    events: [event(4)]
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const queries = [];
  const database = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM mbt_customer_master_inbox")) {
        return {
          rows: [{
            event_uuid: EVENT_IDS[0],
            source_sequence: "4",
            account_id: ACCOUNT_ID,
            subsidiary_id: "77"
          }]
        };
      }
      return { rows: [] };
    }
  };

  const replay = await acceptCustomerMasterEventEnvelope(database, {
    envelope,
    signature,
    secret: SECRET,
    consumerId: CONSUMER_ID
  });
  assert.deepEqual(replay, { accepted: 0, replayed: true });
  assert.equal(queries.length, 2, "replay must stop after locking and inbox verification");

  database.query = async (sql) => sql.includes("FROM mbt_customer_master_inbox")
    ? { rows: [{ event_uuid: EVENT_IDS[0], source_sequence: "5", account_id: ACCOUNT_ID, subsidiary_id: "77" }] }
    : { rows: [] };
  await assert.rejects(
    acceptCustomerMasterEventEnvelope(database, {
      envelope,
      signature,
      secret: SECRET,
      consumerId: CONSUMER_ID
    }),
    (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_EVENT_REUSE", 409)
  );
});

test("P3-F04 contract: every event identity-reuse dimension is bound to signed scope", async (t) => {
  const {
    acceptCustomerMasterEventEnvelope,
    createCustomerMasterEventEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterEventEnvelope({
    accountId: ACCOUNT_ID,
    subsidiaryId: 77,
    events: [event(4)]
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const mismatches = [
    ["unknown event UUID", { event_uuid: EVENT_IDS[1], source_sequence: "4", account_id: ACCOUNT_ID, subsidiary_id: "77" }],
    ["changed account", { event_uuid: EVENT_IDS[0], source_sequence: "4", account_id: "OTHER", subsidiary_id: "77" }],
    ["changed subsidiary", { event_uuid: EVENT_IDS[0], source_sequence: "4", account_id: ACCOUNT_ID, subsidiary_id: "78" }]
  ];
  for (const [name, existing] of mismatches) {
    await t.test(name, async () => {
      const database = {
        async query(sql) {
          return sql.includes("FROM mbt_customer_master_inbox")
            ? { rows: [existing] }
            : { rows: [] };
        }
      };
      await assert.rejects(
        acceptCustomerMasterEventEnvelope(database, {
          envelope,
          signature,
          secret: SECRET,
          consumerId: CONSUMER_ID
        }),
        (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_EVENT_REUSE", 409)
      );
    });
  }
});

test("P3-F04 contract: empty signed event pages replay without inbox or apply writes", async () => {
  const {
    acceptCustomerMasterEventEnvelope,
    createCustomerMasterEventEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterEventEnvelope({
    accountId: ACCOUNT_ID,
    events: [],
    afterSequence: 44
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const statements = [];
  const database = {
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    }
  };
  const result = await acceptCustomerMasterEventEnvelope(database, {
    envelope,
    signature: signature.toUpperCase(),
    secret: SECRET,
    consumerId: CONSUMER_ID
  });
  assert.deepEqual(result, { accepted: 0, replayed: true });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /pg_advisory_xact_lock/u);
});

test("P3-F04 contract: unsupported signed contracts fail before database access", async () => {
  const {
    acceptCustomerMasterEventEnvelope,
    acceptCustomerMasterSnapshotEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  let queries = 0;
  const database = { async query() { queries += 1; return { rows: [] }; } };
  for (const accept of [acceptCustomerMasterEventEnvelope, acceptCustomerMasterSnapshotEnvelope]) {
    const envelope = { contract: "customer-master/v999" };
    const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
    await assert.rejects(
      accept(database, {
        envelope,
        signature,
        secret: SECRET,
        consumerId: CONSUMER_ID
      }),
      (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_CONTRACT_UNSUPPORTED", 400)
    );
  }
  assert.equal(queries, 0);
});

test("P3-F04 contract: invalid aggregate identity rolls back the owned transaction", async () => {
  const {
    acceptCustomerMasterEventEnvelope,
    createCustomerMasterEventEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterEventEnvelope({
    accountId: ACCOUNT_ID,
    events: [event(8, 0, { aggregate: { netsuiteId: 999 } })]
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const statements = [];
  let released = 0;
  const client = {
    async query(sql) {
      statements.push(sql.trim().split(/\s+/u).slice(0, 4).join(" "));
      return { rows: [] };
    },
    release() { released += 1; }
  };
  const pool = {
    async connect() { return client; },
    async query() { throw new Error("pool query must not escape the transaction"); }
  };

  await assert.rejects(
    acceptCustomerMasterEventEnvelope(pool, {
      envelope,
      signature,
      secret: SECRET,
      consumerId: CONSUMER_ID
    }),
    (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_EVENT_INVALID", 400)
  );
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(released, 1);
});

test("P3-F04 contract: snapshot paging is stable, immutable, capped, and cursor-bound", async () => {
  const { createCustomerMasterSnapshotEnvelope, CUSTOMER_MASTER_CONTRACT } = await futureContract();
  const customers = [
    { netsuiteId: 3, displayName: "Third" },
    { netsuiteId: 1, displayName: "First" },
    { netsuiteId: 2, displayName: "Second" }
  ];
  const before = structuredClone(customers);
  const first = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    subsidiaryId: "7",
    customers,
    maxRecords: 2
  });

  assert.equal(first.contract, CUSTOMER_MASTER_CONTRACT);
  assert.equal(first.pageCursor, "START");
  assert.equal(first.complete, false);
  assert.equal(first.subsidiaryId, "7");
  assert.deepEqual(first.customers.map(({ netsuiteId }) => netsuiteId), [1, 2]);
  assert.ok(first.nextCursor);
  assert.deepEqual(customers, before, "snapshot sorting must not mutate caller-owned evidence");

  const second = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    subsidiaryId: 7,
    customers,
    cursor: first.nextCursor,
    maxRecords: 2
  });
  assert.equal(second.pageCursor, first.nextCursor);
  assert.equal(second.nextCursor, null);
  assert.equal(second.complete, true);
  assert.deepEqual(second.customers, [{ netsuiteId: 3, displayName: "Third" }]);

  const oversized = Array.from({ length: 1001 }, (_, index) => ({ netsuiteId: index + 1 }));
  const capped = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    customers: oversized,
    maxRecords: 100_000
  });
  assert.equal(capped.customers.length, 1000);
  assert.equal(capped.complete, false);
  assert.ok(capped.nextCursor);
});

test("P3-F04 contract: snapshot cursors and records reject malformed or cross-snapshot evidence", async (t) => {
  const { createCustomerMasterSnapshotEnvelope } = await futureContract();
  const base = {
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    customers: [{ netsuiteId: 1 }]
  };
  const otherCursor = Buffer.from(JSON.stringify({
    snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    offset: 0
  }), "utf8").toString("base64url");
  for (const [name, cursor] of [
    ["malformed", "%%%"],
    ["other snapshot", otherCursor],
    ["negative offset", Buffer.from(JSON.stringify({ snapshotId: SNAPSHOT_ID, offset: -1 })).toString("base64url")],
    ["fractional offset", Buffer.from(JSON.stringify({ snapshotId: SNAPSHOT_ID, offset: 0.5 })).toString("base64url")]
  ]) {
    await t.test(name, () => {
      assert.throws(
        () => createCustomerMasterSnapshotEnvelope({ ...base, cursor }),
        (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_CURSOR_INVALID", 400)
      );
    });
  }

  const typeCases = [
    ["snapshot ID", { ...base, snapshotId: "bad" }, "Customer master snapshot ID must be a UUID."],
    ["customer collection", { ...base, customers: {} }, "Customer master snapshot customers must be an array."],
    ["customer record", { ...base, customers: [[]] }, "Customer master snapshot customer must be an object."],
    ["customer ID", { ...base, customers: [{ netsuiteId: 0 }] }, "Snapshot customer ID must be a positive integer."],
    ["snapshot bound", { ...base, maxRecords: 0 }, "Customer master snapshot bound must be a positive integer."],
    ["blank cursor", { ...base, cursor: "  " }, "Customer master snapshot cursor is required."]
  ];
  for (const [name, input, message] of typeCases) {
    await t.test(name, () => {
      assert.throws(
        () => createCustomerMasterSnapshotEnvelope(input),
        (error) => exactTypeError(error, message)
      );
    });
  }
});

test("P3-F04 contract: accepted snapshot page replays are read-only and content-bound", async () => {
  const { canonicalSha256 } = await import("../../../src/mbt/canonical-json.js");
  const {
    acceptCustomerMasterSnapshotEnvelope,
    createCustomerMasterSnapshotEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    customers: []
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const pageHash = canonicalSha256(envelope);
  const statements = [];
  const database = {
    async query(sql) {
      statements.push(sql);
      return sql.includes("FROM mbt_customer_master_snapshot_pages")
        ? { rows: [{ page_hash: pageHash }] }
        : { rows: [] };
    }
  };

  const replay = await acceptCustomerMasterSnapshotEnvelope(database, {
    envelope,
    signature,
    secret: SECRET,
    consumerId: CONSUMER_ID
  });
  assert.deepEqual(replay, { accepted: 0, replayed: true, complete: true });
  assert.equal(statements.length, 2, "a replay must stop after lock and page-hash verification");

  database.query = async (sql) => sql.includes("FROM mbt_customer_master_snapshot_pages")
    ? { rows: [{ page_hash: "different-content" }] }
    : { rows: [] };
  await assert.rejects(
    acceptCustomerMasterSnapshotEnvelope(database, {
      envelope,
      signature,
      secret: SECRET,
      consumerId: CONSUMER_ID
    }),
    (error) => exactMbtError(error, "MBT_CUSTOMER_MASTER_SNAPSHOT_PAGE_REUSE", 409)
  );
});

test("P3-F04 contract: a new empty snapshot page records progress without customer writes", async () => {
  const {
    acceptCustomerMasterSnapshotEnvelope,
    createCustomerMasterSnapshotEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    customers: [],
    cursor: Buffer.from(JSON.stringify({ snapshotId: SNAPSHOT_ID, offset: 0 })).toString("base64url")
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM netsuite_customer_sync_runs")) {
        return { rows: [{ status: "running", account_id: ACCOUNT_ID, subsidiary_id: null }] };
      }
      return { rows: [] };
    }
  };

  const result = await acceptCustomerMasterSnapshotEnvelope(database, {
    envelope: { ...envelope, complete: false },
    signature: signCustomerMasterEnvelope({ secret: SECRET, envelope: { ...envelope, complete: false } }),
    secret: SECRET,
    consumerId: CONSUMER_ID
  });
  assert.deepEqual(result, { accepted: 0, replayed: false, complete: false, inactivated: 0 });
  assert.equal(calls.length, 6);
  assert.equal(calls.some(({ sql }) => sql.includes("applyCanonicalCustomerAggregates")), false);
  assert.equal(calls.some(({ sql }) => sql.includes("DELETE FROM return_customer_directory")), false);
  assert.deepEqual(calls.find(({ sql }) => sql.includes("INSERT INTO mbt_customer_master_snapshot_pages"))?.params?.slice(-2), [0, false]);
  assert.match(signature, /^[0-9a-f]{64}$/u);
});

test("P3-F04 contract: completing an empty snapshot reconciles missing customers exactly once", async () => {
  const {
    acceptCustomerMasterSnapshotEnvelope,
    createCustomerMasterSnapshotEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    subsidiaryId: 77,
    customers: []
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM netsuite_customer_sync_runs")) {
        return { rows: [{ status: "running", account_id: ACCOUNT_ID, subsidiary_id: "77" }] };
      }
      if (sql.includes("UPDATE netsuite_customers c")) {
        return { rows: [{ netsuite_id: "501" }, { netsuite_id: "502" }] };
      }
      return { rows: [] };
    }
  };

  const result = await acceptCustomerMasterSnapshotEnvelope(database, {
    envelope,
    signature,
    secret: SECRET,
    consumerId: CONSUMER_ID
  });
  assert.deepEqual(result, { accepted: 0, replayed: false, complete: true, inactivated: 2 });
  const directoryDelete = calls.find(({ sql }) => sql.includes("DELETE FROM return_customer_directory"));
  assert.deepEqual(directoryDelete?.params, [["501", "502"]]);
  assert.equal(calls.filter(({ sql }) => sql.includes("SET status = 'completed'")).length, 1);
  assert.equal(calls.filter(({ sql }) => sql.includes("last_complete_snapshot_id")).length, 1);
});

test("P3-F04 contract: snapshot run scope and lifecycle mismatches block all page writes", async (t) => {
  const {
    acceptCustomerMasterSnapshotEnvelope,
    createCustomerMasterSnapshotEnvelope,
    signCustomerMasterEnvelope
  } = await futureContract();
  const envelope = createCustomerMasterSnapshotEnvelope({
    snapshotId: SNAPSHOT_ID,
    accountId: ACCOUNT_ID,
    customers: []
  });
  const signature = signCustomerMasterEnvelope({ secret: SECRET, envelope });
  const cases = [
    ["missing run", null, "MBT_CUSTOMER_MASTER_SNAPSHOT_REUSE"],
    ["changed account", { status: "running", account_id: "OTHER", subsidiary_id: null }, "MBT_CUSTOMER_MASTER_SNAPSHOT_REUSE"],
    ["changed subsidiary", { status: "running", account_id: ACCOUNT_ID, subsidiary_id: "77" }, "MBT_CUSTOMER_MASTER_SNAPSHOT_REUSE"],
    ["already complete", { status: "completed", account_id: ACCOUNT_ID, subsidiary_id: null }, "MBT_CUSTOMER_MASTER_SNAPSHOT_COMPLETE"]
  ];
  for (const [name, runRow, code] of cases) {
    await t.test(name, async () => {
      const statements = [];
      const database = {
        async query(sql) {
          statements.push(sql);
          if (sql.includes("FROM netsuite_customer_sync_runs")) {
            return { rows: runRow ? [runRow] : [] };
          }
          return { rows: [] };
        }
      };
      await assert.rejects(
        acceptCustomerMasterSnapshotEnvelope(database, {
          envelope,
          signature,
          secret: SECRET,
          consumerId: CONSUMER_ID
        }),
        (error) => exactMbtError(error, code, 409)
      );
      assert.equal(statements.some((sql) => sql.includes("INSERT INTO mbt_customer_master_snapshot_pages")), false);
    });
  }
});

test("P3-F04 contract: consumer state has exact empty and bigint-safe projections", async () => {
  const { readCustomerMasterConsumerState, CUSTOMER_MASTER_CONTRACT } = await futureContract();
  const calls = [];
  const rows = [[], [{
    high_water_sequence: "9007199254740993",
    last_complete_snapshot_id: SNAPSHOT_ID,
    revision: "9007199254740994",
    last_success_at: "2026-08-04T11:15:00-04:00"
  }]];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: rows.shift() };
    }
  };

  const empty = await readCustomerMasterConsumerState(database, {
    consumerId: ` ${CONSUMER_ID} `,
    accountId: ` ${ACCOUNT_ID} `,
    subsidiaryId: null
  });
  assert.deepEqual(empty, {
    contract: CUSTOMER_MASTER_CONTRACT,
    consumerId: CONSUMER_ID,
    accountId: ACCOUNT_ID,
    subsidiaryId: null,
    highWaterSequence: 0,
    lastCompleteSnapshotId: null,
    revision: 0,
    lastSuccessAt: null
  });

  const populated = await readCustomerMasterConsumerState(database, {
    consumerId: CONSUMER_ID,
    accountId: ACCOUNT_ID,
    subsidiaryId: "7"
  });
  assert.deepEqual(populated, {
    contract: CUSTOMER_MASTER_CONTRACT,
    consumerId: CONSUMER_ID,
    accountId: ACCOUNT_ID,
    subsidiaryId: 7,
    highWaterSequence: "9007199254740993",
    lastCompleteSnapshotId: SNAPSHOT_ID,
    revision: "9007199254740994",
    lastSuccessAt: "2026-08-04T15:15:00.000Z"
  });
  assert.deepEqual(calls.map(({ params }) => params), [
    [CONSUMER_ID, ACCOUNT_ID, null],
    [CONSUMER_ID, ACCOUNT_ID, "7"]
  ]);
});
