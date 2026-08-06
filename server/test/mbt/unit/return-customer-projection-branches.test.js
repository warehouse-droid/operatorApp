import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCanonicalReturnsProjection,
  compareReturnProjectionParity,
  evaluateReturnsProjectionOwnership,
  projectCanonicalCustomerForReturns
} from "../../../src/mbt/return-customer-projection.js";

const GENERATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function canonicalCustomer(overrides = {}) {
  return {
    netsuiteId: 901,
    entityNumber: " C-901\u0000 ",
    legalName: " Canonical   Customer ",
    displayName: " Customer  Display ",
    phone: " 519\t555\n0901 ",
    active: true,
    addresses: [],
    ...overrides
  };
}

test("P3-F05 branch contract: projection rejects hostile identities and preserves bigint identity exactly", () => {
  for (const value of [null, [], "customer"]) {
    assert.throws(
      () => projectCanonicalCustomerForReturns(value),
      /A canonical customer aggregate is required/u
    );
  }
  for (const netsuiteId of [0, -1, 1.5, "0", "-7", "1.5", "customer"] ) {
    assert.throws(
      () => projectCanonicalCustomerForReturns(canonicalCustomer({ netsuiteId })),
      /positive customer NetSuite internal ID/u
    );
  }
  assert.throws(
    () => projectCanonicalCustomerForReturns(canonicalCustomer({
      netsuiteId: "9223372036854775808"
    })),
    /exceeds the PostgreSQL bigint range/u
  );

  const projected = projectCanonicalCustomerForReturns(canonicalCustomer({
    netsuiteId: "9007199254740993",
    displayName: "",
    legalName: "",
    entityNumber: ""
  }));
  assert.equal(projected.id, "9007199254740993");
  assert.equal(projected.internalId, "9007199254740993");
  assert.equal(projected.name, "9007199254740993");
});

test("P3-F05 branch contract: address selection is deterministic and ignores inactive or malformed candidates", () => {
  const projected = projectCanonicalCustomerForReturns(canonicalCustomer({
    addresses: [
      null,
      [],
      { active: false, shippingDefault: true, addressLine1: "Inactive" },
      {
        netsuiteAddressId: "30",
        active: true,
        addressLine1: "Billing only",
        billingDefault: true
      },
      {
        netsuiteAddressId: "20",
        active: true,
        addressLine1: "Secondary shipping",
        shippingDefault: true,
        region: "ON"
      },
      {
        netsuiteAddressId: "10",
        active: true,
        addressLine1: "Primary\u0007 shipping",
        addressLine2: " Unit   4 ",
        shippingDefault: true,
        billingDefault: true,
        city: "Toronto",
        region: "ON",
        postalCode: "M1M 1M1",
        countryCode: "CA"
      }
    ]
  }));
  assert.equal(
    projected.address,
    "Primary shipping, Unit 4, Toronto, ON M1M 1M1, CA"
  );
  assert.equal(projected.code, "C-901");
  assert.equal(projected.phone, "519 555 0901");

  assert.equal(
    projectCanonicalCustomerForReturns(canonicalCustomer({ addresses: "not-an-array" })).address,
    ""
  );
  assert.equal(
    projectCanonicalCustomerForReturns(canonicalCustomer({
      addresses: [{ active: true, region: "ON", postalCode: "" }]
    })).address,
    "ON"
  );
});

test("P3-F05 branch contract: parity reports missing, extra, mismatched, normalized, and empty states", () => {
  assert.deepEqual(compareReturnProjectionParity(), {
    matches: true,
    canonicalActiveCount: 0,
    returnCount: 0,
    missingInternalIds: [],
    extraInternalIds: [],
    mismatchedInternalIds: [],
    canonicalHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    returnHash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
  });

  const canonical = [
    canonicalCustomer({ netsuiteId: "9007199254740993", displayName: "Large" }),
    canonicalCustomer({ netsuiteId: 901, displayName: "Expected" }),
    canonicalCustomer({ netsuiteId: 902, displayName: "Missing" }),
    canonicalCustomer({ netsuiteId: 903, active: false })
  ];
  const returns = [
    {
      id: "9007199254740993",
      code: "C-901",
      companyName: "Canonical Customer",
      name: "Large",
      phone: "519 555 0901",
      address: ""
    },
    {
      internalId: 901,
      entityId: "C-901",
      companyName: "Canonical Customer",
      name: "Changed",
      phone: "519 555 0901",
      address: ""
    },
    {
      internalId: 904,
      entityId: "",
      companyName: "",
      name: "",
      phone: null,
      address: null
    }
  ];
  const parity = compareReturnProjectionParity({ canonicalCustomers: canonical, returnCustomers: returns });
  assert.equal(parity.matches, false);
  assert.deepEqual(parity.missingInternalIds, ["902"]);
  assert.deepEqual(parity.extraInternalIds, ["904"]);
  assert.deepEqual(parity.mismatchedInternalIds, ["901"]);
  assert.notEqual(parity.canonicalHash, parity.returnHash);

  for (const invalid of [null, [], "row"] ) {
    assert.throws(
      () => compareReturnProjectionParity({ returnCustomers: [invalid] }),
      /A Returns customer projection is required/u
    );
  }
});

test("P3-F05 branch contract: projection apply validates input and joins an existing transaction client", async () => {
  await assert.rejects(
    applyCanonicalReturnsProjection({}, { generationId: "invalid", customers: [] }),
    /A UUID projection generation is required/u
  );
  await assert.rejects(
    applyCanonicalReturnsProjection({}, { generationId: GENERATION_ID, customers: null }),
    /Canonical projection customers must be an array/u
  );
  await assert.rejects(
    applyCanonicalReturnsProjection({}, {
      generationId: GENERATION_ID,
      customers: [canonicalCustomer({ active: false })]
    }),
    (error) => error?.code === "MBT_CUSTOMER_SNAPSHOT_EMPTY"
  );
  await assert.rejects(
    applyCanonicalReturnsProjection(null, {
      generationId: GENERATION_ID,
      customers: [canonicalCustomer()]
    }),
    /A PostgreSQL pool or transaction client is required/u
  );
  await assert.rejects(
    applyCanonicalReturnsProjection({}, {
      generationId: GENERATION_ID,
      customers: [canonicalCustomer()]
    }),
    /A PostgreSQL query capability is required/u
  );

  const calls = [];
  const transactionClient = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }
  };
  const result = await applyCanonicalReturnsProjection(transactionClient, {
    generationId: GENERATION_ID,
    customers: [
      canonicalCustomer(),
      canonicalCustomer({ displayName: "Duplicate last occurrence" }),
      canonicalCustomer({ netsuiteId: 902, active: false })
    ]
  });
  assert.deepEqual(result, { generationId: GENERATION_ID, projected: 1, inactive: 2 });
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /INSERT INTO return_customer_directory/u);
  assert.equal(calls[0].params[3], "Duplicate last occurrence");
  assert.match(calls[1].sql, /DELETE FROM return_customer_directory/u);
  assert.match(calls[2].sql, /UPDATE return_customer_directory_sync/u);
});

test("P3-F05 branch contract: owned transactions commit once and roll back safely on a boundary failure", async () => {
  const successCalls = [];
  let releases = 0;
  const successClient = {
    async query(sql, params = []) {
      successCalls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
    release() {
      releases += 1;
    }
  };
  const pool = { async connect() { return successClient; } };
  assert.deepEqual(await applyCanonicalReturnsProjection(pool, {
    generationId: GENERATION_ID,
    customers: [canonicalCustomer()]
  }), { generationId: GENERATION_ID, projected: 1, inactive: 0 });
  assert.equal(successCalls[0].sql, "BEGIN");
  assert.equal(successCalls.at(-1).sql, "COMMIT");
  assert.equal(releases, 1);

  const failureCalls = [];
  const failingClient = {
    async query(sql) {
      failureCalls.push(sql);
      if (/INSERT INTO return_customer_directory/u.test(sql)) {
        throw new Error("injected projection failure");
      }
      if (sql === "ROLLBACK") {
        throw new Error("injected rollback transport failure");
      }
      return { rowCount: 1, rows: [] };
    }
  };
  await assert.rejects(
    applyCanonicalReturnsProjection({ async connect() { return failingClient; } }, {
      generationId: GENERATION_ID,
      customers: [canonicalCustomer()]
    }),
    /injected projection failure/u
  );
  assert.deepEqual(failureCalls.slice(0, 3), [
    "BEGIN",
    failureCalls[1],
    "ROLLBACK"
  ]);
});

test("P3-F05 branch contract: ownership modes require exactly one active writer", () => {
  for (const mode of ["legacy", "dual_read", "rollback"]) {
    assert.deepEqual(evaluateReturnsProjectionOwnership({
      mode,
      legacySchedulerEnabled: false
    }), { allowed: false, reason: "legacy_writer_not_enabled" });
  }
  assert.deepEqual(evaluateReturnsProjectionOwnership({ mode: "future" }), {
    allowed: false,
    reason: "returns_projection_mode_invalid"
  });
});
