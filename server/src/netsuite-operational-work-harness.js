import assert from "node:assert/strict";
import test from "node:test";

import {
  createNetSuiteOperationalWorkRegistry,
  isNetSuiteOperationalWorkActive,
  netSuiteOperationalWorkSnapshot,
  withNetSuiteOperationalWork
} from "./netsuite-operational-work.js";

test("an idle poll does not advertise NetSuite operational work", async () => {
  const registry = createNetSuiteOperationalWorkRegistry();
  const discovered = [];
  if (discovered.length) {
    await registry.run("returns.pending", async () => {});
  }
  assert.equal(registry.isActive(), false);
  assert.deepEqual(registry.snapshot(), { activeCount: 0, labels: [] });
});

test("actual work is visible only while it owns the operational signal", async () => {
  const registry = createNetSuiteOperationalWorkRegistry();
  await registry.run("returns.reconcile", async () => {
    assert.equal(registry.isActive(), true);
    assert.deepEqual(registry.snapshot(), {
      activeCount: 1,
      labels: ["returns.reconcile"]
    });
  });
  assert.equal(registry.isActive(), false);
});

test("the operational signal is reference-counted and always released after failure", async () => {
  const registry = createNetSuiteOperationalWorkRegistry();
  await assert.rejects(
    registry.run("returns.pending", async () => {
      await registry.run("returns.reconcile", async () => {
        assert.deepEqual(registry.snapshot(), {
          activeCount: 2,
          labels: ["returns.pending", "returns.reconcile"]
        });
      });
      throw new Error("simulated NetSuite failure");
    }),
    /simulated NetSuite failure/
  );
  assert.equal(registry.isActive(), false);
  assert.deepEqual(registry.snapshot(), { activeCount: 0, labels: [] });
});

test("invalid work is rejected without acquiring a slot", async () => {
  const registry = createNetSuiteOperationalWorkRegistry();
  await assert.rejects(registry.run("returns.invalid", null), /requires a function/);
  assert.deepEqual(registry.snapshot(), { activeCount: 0, labels: [] });
});

test("the shared registry uses a safe default label and releases it", async () => {
  assert.equal(isNetSuiteOperationalWorkActive(), false);
  await withNetSuiteOperationalWork("   ", async () => {
    assert.equal(isNetSuiteOperationalWorkActive(), true);
    assert.deepEqual(netSuiteOperationalWorkSnapshot(), {
      activeCount: 1,
      labels: ["netsuite.operational"]
    });
  });
  assert.deepEqual(netSuiteOperationalWorkSnapshot(), {
    activeCount: 0,
    labels: []
  });
});
