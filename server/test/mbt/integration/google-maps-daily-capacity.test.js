import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, beforeEach } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { createGoogleMapsUsageRepository } from "../../../src/google-maps-usage-repository.js";
import { GOOGLE_MAPS_USAGE_LIMITS } from "../../../src/google-maps-usage-policy.js";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "An isolated test database is required.");
const limits = { ...GOOGLE_MAPS_USAGE_LIMITS, dailyLimit: 3, hardLimit: 10, normalLimit: 8, conserveLimit: 7 };
const repository = createGoogleMapsUsageRepository({ limits });
const request = (extra = {}) => ({ subsystem: "dynamic_map", api: "test", reason: "manual_refresh", mode: "normal", ...extra });
const today = async () => (await query("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day")).rows[0].day;
const reopen = async (extra = {}) => repository.reopenDailyCapacity({
  requestId: crypto.randomUUID(), day: await today(), expectedLimit: 3, actorId: "test-admin", mode: "normal", ...extra
});

beforeEach(async () => {
  await query("DELETE FROM google_maps_usage_ledger");
  if ((await query("SELECT to_regclass('google_maps_daily_reopens') AS name")).rows[0].name) {
    await query("DELETE FROM google_maps_daily_reopens");
  }
});
after(closeDb);

test("concurrent features share one daily allowance; denied attempts and failed calls count correctly", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => repository.admit(request({
    subsystem: i % 2 ? "driver_geocode" : "dynamic_map"
  }))));
  assert.equal(results.filter((row) => row.admitted).length, 3);
  assert.equal(results.filter((row) => row.reason === "daily_limit").length, 17);
  await repository.recordOutcome({ ledgerId: results.find((row) => row.admitted).ledgerId, outcome: "failed" });
  const summary = await repository.summary();
  assert.equal(summary.dailyCapacity.used, 3);
  assert.equal(summary.dailyCapacity.limit, 3);
  assert.equal(summary.dailyCapacity.remaining, 0);
  assert.equal(summary.dailyCapacity.canReopen, true);
  assert.equal(summary.daily.at(-1).deniedCount, 17);
  assert.equal(summary.daily.at(-1).failedCount, 1);
});

test("concurrent reopens grant once and retries preserve accounting even after later exhaustion", async () => {
  await repository.admit(request({ units: 3 }));
  const before = (await query("SELECT * FROM google_maps_usage_ledger ORDER BY id")).rows;
  const results = await Promise.all(Array.from({ length: 11 }, () => reopen()));
  const requestId = (await query("SELECT id FROM google_maps_daily_reopens")).rows[0].id;
  assert.equal(results.filter((row) => row.reopened).length, 1);
  assert.deepEqual((await query("SELECT * FROM google_maps_usage_ledger ORDER BY id")).rows, before);
  assert.equal((await repository.summary()).dailyCapacity.limit, 6);
  assert.equal((await repository.admit(request({ units: 3 }))).admitted, true);
  await reopen({ requestId });
  assert.equal((await repository.summary()).dailyCapacity.limit, 6);
  const audit = (await query("SELECT * FROM google_maps_daily_reopens")).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].added_units, 3);
  assert.match(audit[0].actor_id, /^[0-9a-f]{64}$/u);
  assert.equal((await repository.admit(request())).reason, "daily_limit");
});

test("a delayed second admin request cannot reopen a newer exhausted allowance", async () => {
  await repository.admit(request({ units: 3 }));
  await reopen();
  await repository.admit(request({ units: 3 }));
  await assert.rejects(reopen(), /capacity changed/iu);
  assert.equal((await repository.summary()).dailyCapacity.limit, 6);
});

test("UTC reset excludes yesterday's calls and reopen grants while retaining rolling usage", async () => {
  const previous = await repository.admit(request({ units: 3 }));
  await reopen();
  await query("UPDATE google_maps_usage_ledger SET requested_at = (((now() AT TIME ZONE 'UTC')::date - 1) AT TIME ZONE 'UTC') WHERE id=$1", [previous.ledgerId]);
  await query("UPDATE google_maps_daily_reopens SET day = (now() AT TIME ZONE 'UTC')::date - 1");
  const summary = await repository.summary();
  assert.equal(summary.rolling30Day, 3);
  assert.equal(summary.dailyCapacity.used, 0);
  assert.equal(summary.dailyCapacity.limit, 3);
  assert.equal(summary.dailyCapacity.extraUnits, 0);
  assert.match(summary.dailyCapacity.resetsAt.toISOString(), /T00:00:00\.000Z$/u);
  assert.equal((await repository.admit(request({ units: 3 }))).admitted, true);
  assert.equal((await repository.admit(request())).reason, "daily_limit");
});

test("reopening grants only remaining rolling capacity and never crosses the hard ceiling", async () => {
  const old = await repository.admit(request({ units: 3 }));
  await query("UPDATE google_maps_usage_ledger SET admitted_units=6, requested_units=6, requested_at=now()-interval '1 day' WHERE id=$1", [old.ledgerId]);
  await repository.admit(request({ units: 3 }));
  assert.equal((await reopen({ units: 99999 })).addedUnits, 1);
  const results = await Promise.all(Array.from({ length: 10 }, () => repository.admit(request())));
  assert.equal(results.filter((row) => row.admitted).length, 1);
  assert.equal((await repository.summary()).rolling30Day, 10);
  await assert.rejects(reopen(), /rolling.*limit/iu);
});

test("invalid or stale requests cannot alter capacity; an unexhausted day cannot be reopened", async () => {
  assert.equal((await reopen()).reopened, false);
  await repository.admit(request({ units: 3 }));
  for (const values of [{ requestId: "bad-id" }, { actorId: "" }, { day: "2000-01-01" }, { mode: "disabled" }]) {
    await assert.rejects(reopen(values));
  }
  assert.equal(Number((await query("SELECT count(*) FROM google_maps_daily_reopens")).rows[0].count), 0);
});
