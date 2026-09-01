import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, catalog, server, adminUi] = await Promise.all([
  readFile(new URL("../../../migrations/185_dispatch_optimized_order_pool_gate.sql", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/feature-gate-catalog.js", import.meta.url), "utf8"),
  readFile(new URL("../../../src/server.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-gates.js", import.meta.url), "utf8")
]);

test("optimized order pool gate is default-off, Admin-visible, and readiness guarded", () => {
  assert.match(migration, /dispatch_optimized_order_pool/u);
  assert.match(migration, /false/u);
  assert.match(migration, /shadow_match_count/u);
  assert.match(migration, /shadow_mismatch_count/u);
  assert.match(migration, /ON\s+CONFLICT\s*\(flag_key\)\s+DO\s+NOTHING/iu);
  assert.match(catalog, /flagKey:\s*["']dispatch_optimized_order_pool["']/u);
  assert.match(catalog, /requiresDispatchOrderPoolReadiness:\s*true/u);
  assert.match(catalog, /dispatchOrderPoolMode\s*===\s*["']on["']/u);
  assert.match(catalog, /dispatchOrderPoolReady\s*===\s*true/u);
  assert.match(adminUi, /dispatchOrderPoolRolloutText/u);
  assert.match(adminUi, /Read path ready/u);
  assert.match(adminUi, /Read path blocked/u);
  assert.match(adminUi, /rolloutBlocked/u);
});

test("server resolves the runtime gate for config, pool, hydration, and snapshot projections", () => {
  assert.match(server, /import\s*\{\s*getDispatchOrderPoolPolicy\s*\}/u);
  assert.match(server, /plannerOrderPoolMode:\s*orderPoolPolicy\.runtimeMode/u);
  assert.match(server, /if\s*\(policy\.effective\)\s*\{[\s\S]{0,300}listDispatchOrderPool/u);
  assert.match(server, /policy\.runtimeMode\s*===\s*["']shadow["']/u);
  assert.match(server, /dispatchOrderPoolRuntimePolicy\(\)\)\.effective/u);
});

test("shadow verification compares the same bounded page on both read paths", () => {
  const routeStart = server.indexOf('app.get("/api/dispatch/v2/order-pool"');
  assert.notEqual(routeStart, -1, "Expected the versioned Dispatch order-pool route.");
  const route = server.slice(routeStart, routeStart + 2_500);
  assert.match(route, /Math\.min\([\s\S]{0,100},\s*200\)/u);
  assert.match(route, /legacy\.orders\.length\s*>=\s*shadowLimit/u);
  assert.match(route, /optimized\.nextCursor/u);
  assert.match(route, /legacy:\s*legacy\.orders\.slice\(0,\s*shadowLimit\)/u);
  assert.match(
    route,
    /optimized:\s*optimized\.orders\.slice\(0,\s*shadowLimit\)/u,
    "A 100-row legacy sample must never be compared with an unbounded optimized page."
  );
});
