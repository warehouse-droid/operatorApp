// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  describeIsolatedTestDatabase,
  isolatedTestDatabaseName,
  isolatedTestDatabaseUrl
} from "../../support/test-database-isolation.mjs";

const DISPOSABLE_URL = "postgres://mbt_test:mbt_test_password@db:5432/mbt_test?application_name=mbt-gauntlet";

test("suite isolation accepts only the exact disposable Compose database boundary", () => {
  const boundary = describeIsolatedTestDatabase(DISPOSABLE_URL, { MBT_TEST_ISOLATED: "1" });
  assert.deepEqual(boundary, {
    baseDatabaseName: "mbt_test",
    adminUrl: "postgres://mbt_test:mbt_test_password@db:5432/postgres?application_name=mbt-gauntlet"
  });

  for (const [databaseUrl, environment] of [
    ["mysql://mbt_test:mbt_test_password@db:5432/mbt_test", { MBT_TEST_ISOLATED: "1" }],
    ["postgres://mbt_test:mbt_test_password@db:5432/production", { MBT_TEST_ISOLATED: "1" }],
    ["postgres://mbt_test:mbt_test_password@production-db:5432/mbt_test", { MBT_TEST_ISOLATED: "1" }],
    ["postgres://production:mbt_test_password@db:5432/mbt_test", { MBT_TEST_ISOLATED: "1" }],
    [DISPOSABLE_URL, {}]
  ]) {
    assert.throws(
      () => describeIsolatedTestDatabase(databaseUrl, environment),
      /isolated disposable mbt_test database/i
    );
  }
});

test("suite isolation derives bounded unique clone names and preserves connection options", () => {
  const first = isolatedTestDatabaseName("20260804-a", 0);
  const replay = isolatedTestDatabaseName("20260804-a", 0);
  const next = isolatedTestDatabaseName("20260804-a", 1);
  assert.equal(first, replay);
  assert.notEqual(first, next);
  assert.match(first, /^mbt_test_file_[a-f0-9]{12}_[a-z0-9]+$/u);
  assert.equal(first.length <= 63, true);
  assert.equal(
    isolatedTestDatabaseUrl(DISPOSABLE_URL, first),
    `postgres://mbt_test:mbt_test_password@db:5432/${first}?application_name=mbt-gauntlet`
  );
  assert.throws(() => isolatedTestDatabaseName("20260804-a", -1), /non-negative safe integer/i);
  assert.throws(
    () => isolatedTestDatabaseUrl(DISPOSABLE_URL, "production"),
    /isolated clone database name/i
  );
});

test("suite isolation owns clone, one-file execution, and unconditional cleanup", async () => {
  const source = await readFile(new URL("../../support/test-database-isolation.mjs", import.meta.url), "utf8");
  assert.match(source, /CREATE DATABASE[\s\S]*TEMPLATE/u);
  assert.match(source, /DROP DATABASE[\s\S]*WITH \(FORCE\)/u);
  assert.match(source, /pg_terminate_backend/u);
  assert.match(source, /finally[\s\S]*dropCloneDatabase/u);
  assert.match(source, /--test-concurrency=1/u);
  assert.match(
    source,
    /const databaseName = isolatedTestDatabaseName\(runId, index\);/u
  );
  assert.match(
    source,
    /DATABASE_URL:\s*isolatedTestDatabaseUrl\(databaseUrl, databaseName\)/u
  );
});
