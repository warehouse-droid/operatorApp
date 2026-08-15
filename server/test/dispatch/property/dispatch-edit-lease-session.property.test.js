import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = dispatchSource.indexOf(marker);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = dispatchSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "(") {
      parameterDepth += 1;
    }
    if (dispatchSource[index] === ")") {
      parameterDepth -= 1;
    }
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `Could not read ${name} parameters.`);
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {
      depth += 1;
    }
    if (dispatchSource[index] === "}") {
      depth -= 1;
    }
    if (!depth) {
      return dispatchSource.slice(start, index + 1);
    }
  }
  throw new Error(`Could not read ${name}.`);
}

const parseStoredDispatchEditLease = Function(
  `"use strict"; return (${functionBody("parseStoredDispatchEditLease")});`
)();

function seededValues(seed, count) {
  let state = seed >>> 0;
  return Array.from({ length: count }, (_, index) => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return `${index.toString(36)}-${state.toString(36)}`;
  });
}

test("stored edit leases round-trip only inside their exact plan and tab session", () => {
  const values = seededValues(20260814, 256);
  for (let index = 0; index < values.length; index += 1) {
    const suffix = values[index];
    const planDate = `20${String(30 + (index % 60)).padStart(2, "0")}-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`;
    const sessionId = `dispatch-session-${suffix}`;
    const editLeaseToken = `lease-token-${suffix}`;
    const stored = { planDate, sessionId, editLeaseToken, expiresAt: `${planDate}T23:59:59.000Z` };

    assert.deepEqual(
      parseStoredDispatchEditLease(JSON.stringify(stored), { planDate, sessionId }),
      stored,
      `valid lease ${index} did not round-trip`
    );
    assert.equal(
      parseStoredDispatchEditLease(JSON.stringify(stored), { planDate: "2099-12-31", sessionId }),
      null,
      `lease ${index} crossed a plan-date boundary`
    );
    assert.equal(
      parseStoredDispatchEditLease(JSON.stringify(stored), { planDate, sessionId: `${sessionId}-other` }),
      null,
      `lease ${index} crossed a tab-session boundary`
    );
  }
});

test("stored edit lease parsing fails closed for malformed and incomplete values", () => {
  const scope = { planDate: "2026-08-14", sessionId: "dispatch-session-a" };
  for (const rawValue of [
    "",
    "not-json",
    "null",
    "true",
    "42",
    "[]",
    "{}",
    JSON.stringify({ planDate: scope.planDate, sessionId: scope.sessionId }),
    JSON.stringify({ planDate: scope.planDate, editLeaseToken: "test-edit-lease" }),
    JSON.stringify({ sessionId: scope.sessionId, editLeaseToken: "test-edit-lease" })
  ]) {
    assert.equal(parseStoredDispatchEditLease(rawValue, scope), null, `accepted hostile value: ${rawValue}`);
  }
});
