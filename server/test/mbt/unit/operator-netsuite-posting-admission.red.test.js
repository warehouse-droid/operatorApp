// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { createOperatorNetSuitePostingAdmission } from "../../../src/operator-netsuite-posting-admission.js";

const RESOLUTION = Object.freeze({
  functionKey: "delivery_prep",
  transactionType: "IF",
  canonicalLocationId: 15,
  localOnly: false,
  localOrderKeys: ["delivery_prep:sales_order:101"],
  localOperation: { kind: "delivery_prep_load", orderId: "101", orderType: "sales_order" },
  targets: [{
    sourceOrderKind: "SO",
    sourceNetSuiteId: 101,
    sourceOrderRef: "SOA101",
    selectedLines: [{ orderLine: 1, quantity: 2, location: 15, localOrderKey: "delivery_prep:sales_order:101", localLineId: "1001" }],
    availableLines: [{ orderLine: 1, location: 15 }]
  }]
});

const ON_POLICY = Object.freeze({
  gateKey: "operator_netsuite_delivery_prep_if_12441",
  revision: 5,
  effective: true,
  configured: true,
  functionKey: "delivery_prep",
  transactionType: "IF",
  locationId: 15,
  yardCode: "12441"
});

function harness({ resolution = RESOLUTION, policy = ON_POLICY } = {}) {
  const calls = { resolve: 0, policy: 0, preflight: 0, create: 0, accepted: 0, draft: null };
  const admission = createOperatorNetSuitePostingAdmission({
    resolveTargets: async () => { calls.resolve += 1; return structuredClone(resolution); },
    getPolicy: async () => { calls.policy += 1; return structuredClone(policy); },
    preflight: async () => { calls.preflight += 1; },
    createCommand: async (draft) => {
      calls.create += 1;
      calls.draft = draft;
      return { replayed: false, command: { id: draft.requestId, status: "queued", inputHash: draft.inputHash } };
    },
    onAccepted: async () => { calls.accepted += 1; }
  });
  return { admission, calls };
}

function input(overrides = {}) {
  return {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actorOperatorId: "operator-one",
    functionKey: "delivery_prep",
    orderId: "101",
    orderType: "sales_order",
    clientLocationId: 15,
    photoRefs: ["r2://operator/a.jpg", "r2://operator/b.jpg"],
    expectedPolicy: { gateKey: ON_POLICY.gateKey, revision: ON_POLICY.revision, effective: true },
    ...overrides
  };
}

test("G1-G3 gate-off, ceiling-off, and local-only actions create no durable command", async () => {
  for (const policy of [
    { ...ON_POLICY, configured: false, effective: false },
    { ...ON_POLICY, environmentAllowed: false, effective: false }
  ]) {
    const { admission, calls } = harness({ policy });
    const result = await admission(input());
    assert.equal(result.mode, "local_only");
    assert.equal(calls.create, 0);
    assert.equal(calls.preflight, 0);
    assert.equal(calls.accepted, 0);
  }
  const { admission, calls } = harness({ resolution: { ...RESOLUTION, localOnly: true, targets: [] } });
  const result = await admission(input());
  assert.equal(result.mode, "local_only");
  assert.equal(calls.policy, 0, "A structurally local order never consults or acquires a remote-post gate.");
  assert.equal(calls.create, 0);
  assert.equal(calls.preflight, 0);
});

test("G1 gate-off local completion never evaluates posting-only line targets", async () => {
  const calls = { materialize: 0, create: 0 };
  const admission = createOperatorNetSuitePostingAdmission({
    resolveTargets: async () => ({
      ...RESOLUTION,
      targets: [],
      materializeTargets: async () => {
        calls.materialize += 1;
        throw new Error("Posting-only targets must stay lazy while the gate is off.");
      }
    }),
    getPolicy: async () => ({ ...ON_POLICY, configured: false, effective: false }),
    createCommand: async () => { calls.create += 1; },
    onAccepted: async () => {}
  });
  const result = await admission(input());
  assert.equal(result.mode, "local_only");
  assert.equal(result.reason, "gate_off");
  assert.equal(calls.materialize, 0);
  assert.equal(calls.create, 0);
});

test("G4 a gate-on action requires the exact current policy token before command creation", async () => {
  for (const expectedPolicy of [undefined, { gateKey: ON_POLICY.gateKey, revision: 4, effective: true }]) {
    const { admission, calls } = harness();
    await assert.rejects(
      admission(input({ expectedPolicy })),
      (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_POLICY_CHANGED"
    );
    assert.equal(calls.create, 0);
    assert.equal(calls.preflight, 0);
  }
});

test("P5/P9 one accepted canonical draft is durable and scheduled after admission", async () => {
  const { admission, calls } = harness();
  const result = await admission(input());
  assert.equal(result.mode, "netsuite");
  assert.equal(result.command.status, "queued");
  assert.equal(result.policy.revision, 5);
  assert.equal(calls.create, 1);
  assert.equal(calls.preflight, 1);
  assert.equal(calls.accepted, 1);
});

test("R1 admission freezes the stable local payload separately from the remote transform payload", async () => {
  const localPayload = {
    item: { items: [{ orderLine: 4850690, quantity: 5, itemReceive: true, location: 1 }] }
  };
  const { admission, calls } = harness({
    resolution: { ...RESOLUTION, localPayload }
  });
  await admission(input());
  assert.deepEqual(calls.draft.localPayload, localPayload);
  assert.deepEqual(calls.draft.inputSnapshot.localPayload, localPayload);
  assert.equal(calls.draft.steps[0].payload.item.items[0].orderLine, 1);
});
