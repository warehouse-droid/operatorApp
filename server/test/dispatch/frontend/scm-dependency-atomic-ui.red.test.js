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
    if (dispatchSource[index] === "(") {parameterDepth += 1;}
    if (dispatchSource[index] === ")") {parameterDepth -= 1;}
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {depth += 1;}
    if (dispatchSource[index] === "}") {depth -= 1;}
    if (!depth) {return dispatchSource.slice(start, index + 1);}
  }
  throw new Error(`Could not read ${name}.`);
}

test("Dispatch dependency commands carry the exact saved plan fence and a request UUID", () => {
  const payload = functionBody("dispatchLeaseRequestPayload");
  assert.match(payload, /planId:\s*currentPlan\?\.id\s*\|\|\s*null/u);
  assert.match(payload, /expectedPlanRevision:\s*currentPlan\?\.revision/u);
  assert.match(payload, /expectedPlanDigest:\s*currentPlan\?\.digest/u);

  const requestId = functionBody("newDependencyRequestId");
  assert.match(requestId, /crypto\.randomUUID/u);
});

test("an atomic dependency response replaces the local snapshot and never schedules a second save", () => {
  const apply = functionBody("applyAtomicDependencyMutationPayload");
  assert.match(apply, /payload\?\.pending/u);
  assert.match(apply, /applySavedPlan\(payload\.plan\)/u);
  assert.match(apply, /compactCurrentPlan\(payload\.plan\)/u);
  assert.match(apply, /resetLocalPlanDirty\(\)/u);
  assert.match(apply, /resetUndoHistory\(\)/u);
  assert.doesNotMatch(apply, /commitPlanMutation|queueServerSave|requestOrderPoolRefreshOnNextSave/u);
});

test("all four Dispatch relationship flows flush autosave then consume the atomic plan", () => {
  assert.match(dispatchSource, /async function runAtomicDispatchDependencyMutation\(/u);
  const runner = functionBody("runAtomicDispatchDependencyMutation");
  assert.match(runner, /await saveCurrentPlanNow\(\)/u);
  assert.match(runner, /applyAtomicDependencyMutationPayload/u);

  for (const action of ["update-dependency-mode", "unlink-dependency", "cancel-po-link"]) {
    const start = dispatchSource.indexOf(`action === "${action}"`);
    assert.ok(start >= 0, `Expected ${action} handler.`);
    const section = dispatchSource.slice(start, start + 3_500);
    assert.match(section, /runAtomicDispatchDependencyMutation/u, `${action} must use the atomic runner.`);
  }

  for (const formName of ["to-link", "po-link"]) {
    const start = dispatchSource.indexOf(`form.dataset.form === "${formName}"`);
    assert.ok(start >= 0, `Expected ${formName} form.`);
    const section = dispatchSource.slice(start, start + 8_000);
    assert.match(section, /runAtomicDispatchDependencyMutation/u, `${formName} must use the atomic runner.`);
  }
});
