import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../../../public/operator.js", import.meta.url), "utf8");
function functionSource(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, `missing ${name}`);
  const next = source.slice(match.index + match[0].length).search(/\n(?:async )?function /);
  return source.slice(match.index, next < 0 ? undefined : match.index + match[0].length + next);
}
function client(overrides = {}) {
  const context = vm.createContext({ returnMode: "stock", returnPalletQuantity: 3, locationId: 1,
    returnPostingPolicies: {}, returnPostingError: "", returnPostingLoading: false, returnPostingGeneration: 0,
    returnSelectedRows: () => [{}], render: () => {}, ...overrides });
  for (const name of ["operatorNetSuitePolicyToken", "returnPostingFunctions", "returnPostingReady", "loadReturnPostingPolicies"]) {
    vm.runInContext(functionSource(name), context);
  }
  return context;
}

test("U1 combined review waits for both yard policies and enables confirmation only when loaded", async () => {
  const pending = [];
  const c = client({ loadOperatorNetSuitePostingPolicy: key => new Promise(resolve => pending.push({ key, resolve })) });
  const loading = c.loadReturnPostingPolicies();
  assert.equal(c.returnPostingReady(), false);
  // Policy loading may be concurrent or sequential.
  for (let i = 0; i < 2; i++) {
    await Promise.resolve();
    const request = pending[i];
    assert.ok(request);
    request.resolve({ functionKey: request.key, locationId: 1, gateKey: request.key, revision: 2, effective: true });
    await Promise.resolve();
  }
  await loading;
  assert.equal(c.returnPostingReady(), true);
  assert.deepEqual(Object.keys(c.returnPostingPolicies).sort(), ["pallet_return", "stock_return"]);
  c.locationId = 28;
  assert.equal(c.returnPostingReady(), false);
});

test("U1 a policy request for a previous yard cannot replace the current review", async () => {
  const pending = [];
  const c = client({ returnPalletQuantity: 0,
    loadOperatorNetSuitePostingPolicy: key => new Promise(resolve => pending.push({ key, resolve })) });
  const first = c.loadReturnPostingPolicies();
  c.locationId = 28;
  const second = c.loadReturnPostingPolicies();
  pending[1].resolve({ locationId: 28, gateKey: "current", revision: 2, effective: false });
  await second;
  pending[0].resolve({ locationId: 1, gateKey: "stale", revision: 1, effective: true });
  await first;
  assert.equal(c.returnPostingPolicies.stock_return.gateKey, "current");
  assert.equal(c.returnPostingReady(), true);
});

test("U1 success labels separate local, pending, failed and verified RA results", () => {
  const c = vm.createContext({});
  vm.runInContext(functionSource("returnNetSuiteResultLabel"), c);
  const label = netSuiteSyncStatus => c.returnNetSuiteResultLabel({ workflowVersion: 2, netSuiteSyncStatus });
  assert.match(label("disabled"), /Local only/);
  assert.match(label("pending"), /RA pending/);
  assert.match(label("failed"), /RA failed/);
  assert.match(c.returnNetSuiteResultLabel({ workflowVersion: 2, netSuiteSyncStatus: "succeeded",
    netSuiteTransactionRef: "RA123" }), /RA123/);
});

test("U1 Operator responses expose the new RA reference while keeping financial and recovery data private", () => {
  const server = readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
  const c = vm.createContext({});
  vm.runInContext(server.slice(server.indexOf("const OPERATOR_RETURN_PRIVATE_KEYS"), server.indexOf("function returnListFilters(")), c);
  const input = { workflowVersion: 2, netSuiteTransactionRef: "RA123", netSuiteTransactionId: 44,
    netSuiteSyncStatus: "succeeded", rate: 40, actualCredit: 80, netSuiteRaAttemptedAt: "now",
    linkedCredits: [{ transactionId: 1, quantity: 2 }], netSuiteSnapshot: { total: 80 },
    lines: [{ returnedSalesQuantity: 2, rate: 40 }] };
  const safe = JSON.parse(JSON.stringify(c.operatorSafeReturnPayload(input)));
  assert.deepEqual(safe, { workflowVersion: 2, netSuiteTransactionRef: "RA123", netSuiteTransactionId: 44,
    netSuiteSyncStatus: "succeeded", lines: [{ returnedSalesQuantity: 2 }] });
  assert.equal(c.operatorSafeReturnPayload({ ...input, workflowVersion: 1 }).netSuiteTransactionRef, undefined);
});


test("B3 shared batch RA number is prominent and survives the Operator privacy filter", () => {
  const c = vm.createContext({ returnResult: { batchReference: "RB-000004",
    stockReturn: { workflowVersion: 3, netSuiteSyncStatus: "succeeded", netSuiteTransactionRef: "RMA00999", reference: "SR-000004" },
    palletReturn: { workflowVersion: 3, netSuiteSyncStatus: "succeeded", netSuiteTransactionRef: "RMA00999", reference: "PR-000001" } },
    escapeHtml: value => String(value ?? ""), t: (_, fallback) => fallback, localizeMessage: value => value });
  for (const name of ["returnNetSuiteResultLabel", "renderReturnSuccess"]) {vm.runInContext(functionSource(name), c);}
  assert.match(c.renderReturnSuccess(), /<strong>RMA00999<\/strong>/);
  assert.match(c.returnNetSuiteResultLabel({ workflowVersion: 3, netSuiteSyncStatus: "failed" }), /RA failed/);
  const server = readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");
  vm.runInContext(server.slice(server.indexOf("const OPERATOR_RETURN_PRIVATE_KEYS"), server.indexOf("function returnListFilters(")), c);
  const safe = c.operatorSafeReturnPayload({ workflowVersion: 3, netSuiteTransactionRef: "RMA00999", rate: 40 });
  assert.equal(safe.netSuiteTransactionRef, "RMA00999");
  assert.equal(safe.rate, undefined);
  c.returnResult.stockReturn.netSuiteSyncStatus = "cancelled";
  c.returnResult.palletReturn.netSuiteSyncStatus = "cancelled";
  assert.match(c.returnNetSuiteResultLabel(c.returnResult.stockReturn), /RMA00999.*cancelled/);
  assert.match(c.renderReturnSuccess(), /<strong>RMA00999<\/strong>/);
});
