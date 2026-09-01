import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
  assert.match(runner, /await refreshDispatchDependencyPlanFence\(\)/u,
    "a no-op autosave must still refresh the server revision/digest before previewing a dependency");
  assert.ok(
    runner.indexOf("await saveCurrentPlanNow()") < runner.indexOf("await refreshDispatchDependencyPlanFence()"),
    "the dependency fence must describe the plan after autosave"
  );
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

test("the dependency fence refresh uses the lightweight revision endpoint", () => {
  const refresh = functionBody("refreshDispatchDependencyPlanFence");
  assert.match(refresh, /\/api\/dispatch\/plans\/\$\{encodeURIComponent\(currentPlan\.id\)\}\/revision/u);
  assert.match(refresh, /currentPlan[\s\S]*revision:\s*Number\(fence\.revision/u);
  assert.match(refresh, /digest:\s*fence\.digest/u);
});

test("Link PO lets the user explicitly classify MBBS-Special SO and PO service fees", () => {
  const board = functionBody("renderPoLinkMatchBoard");
  assert.match(board, /serviceFeeSelectable/u);
  assert.match(board, /data-so-service-fee-line/u);
  assert.match(board, /data-po-direct-service-line/u);
  assert.match(board, /Service fee only/u);
  assert.match(board, /No physical pickup/u);

  const modal = functionBody("renderPoLinkModal");
  assert.doesNotMatch(modal, /po-direct-service-options|<strong>Service fee lines<\/strong>/u,
    "service-fee choices belong on their matching cards, not in a second list");
  assert.match(modal, /renderPoLinkMatchBoard\(order,\s*salesLines,\s*selectedPoLines,\s*draft\)/u,
    "checked service-fee cards must stay visible on the matching board");
  assert.match(modal, /UOM mismatch is a different item/u);
  assert.match(modal, /selectedPoHasAllocation/u,
    "an existing material link must allow a later service-route-only edit");

  const capture = functionBody("captureActiveLinkModalDraft");
  assert.match(capture, /serviceSalesLineKeys/u);
  assert.match(capture, /directServicePoLineIds/u);
  const clearMatches = functionBody("clearPoLinkServiceFeeMatches");
  assert.match(clearMatches, /draft\.poLineIds\[targetLineKey\]\s*=\s*""/u);
  assert.match(clearMatches, /draft\.quantities\[targetLineKey\]\s*=\s*\{\}/u);
  const submitStart = dispatchSource.indexOf('form.dataset.form === "po-link"');
  assert.ok(submitStart >= 0);
  assert.match(
    dispatchSource.slice(submitStart, submitStart + 8_000),
    /directServicePoLineIds:\s*draft\.directServicePoLineIds/u
  );
  assert.match(
    dispatchSource.slice(submitStart, submitStart + 8_000),
    /serviceSalesLineKeys:\s*draft\.serviceSalesLineKeys/u
  );
  assert.match(
    dispatchSource.slice(submitStart, submitStart + 8_000),
    /!lines\.length\s*&&\s*!hasExistingPoLink/u
  );
});

test("checked Link PO service-fee cards stay visible and stop material matching", () => {
  const context = vm.createContext({
    availableQtyTextForLine: () => "1 PC",
    escapeHtml: (value) => String(value ?? ""),
    poLinkMatchMeta: () => ({ exactMatch: true, descriptionMatch: true, unitMatch: true }),
    poLinkRefMatches: () => true
  });
  vm.runInContext(functionBody("renderPoLinkMatchBoard"), context);
  context.order = { id: "SO-1" };
  context.salesLines = [{
    id: 11,
    lineId: 1,
    targetLineKey: "SO-1:11",
    sourceOrderRef: "SO-1",
    sku: "MBBS-Special Order",
    description: "Cutting fee",
    serviceFeeSelectable: true
  }];
  context.poLines = [{
    id: 22,
    lineId: 2,
    poRef: "PO-1",
    sku: "MBBS-Special Order",
    description: "Cutting fee",
    serviceFeeSelectable: true
  }];
  context.draft = {
    ref: "PO-1",
    poLineIds: { "SO-1:11": "22" },
    pendingSoLineKey: "SO-1:11",
    serviceSalesLineKeys: ["SO-1:11"],
    directServicePoLineIds: ["22"]
  };

  const html = vm.runInContext(
    "renderPoLinkMatchBoard(order, salesLines, poLines, draft)",
    context
  );
  assert.match(html, /data-target-line-key="SO-1:11"[^>]*disabled/u);
  assert.match(html, /data-po-line-id="22"[^>]*disabled/u);
  assert.match(html, /data-so-service-fee-line value="SO-1:11" checked/u);
  assert.match(html, /data-po-direct-service-line value="22" checked/u);
  assert.match(html, /0 matched · 0 remaining/u);
  assert.doesNotMatch(html, /Connected to PO line/u);
});
