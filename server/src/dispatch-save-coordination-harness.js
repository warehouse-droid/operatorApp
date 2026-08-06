import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker, description = startMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected ${description} source was not found.`);
  return source.slice(start, end);
}

const catalogStructureSource = sourceSlice(
  "function catalogStructureConflictsWithSavedPlan",
  "function splitSiblingsForOrder",
  "saved-plan catalog structure guard"
);
const catalogStructureConflictsWithSavedPlan = Function(
  `"use strict"; ${catalogStructureSource}; return catalogStructureConflictsWithSavedPlan;`
)();
const historicalPlan = {
  id: 36,
  planDate: "2026-07-10",
  orders: [
    { id: "SOA04857", type: "SO" },
    { id: "SOA04893", type: "SO" },
    { id: "SOB114411", type: "SO" }
  ]
};
assert.equal(
  catalogStructureConflictsWithSavedPlan({
    id: "GOA-4857-4893",
    type: "SO",
    childOrders: ["SOA04857", "SOA04893"],
    dispatchSnapshotSourcePlanId: "52",
    dispatchSnapshotSourcePlanDate: "2026-07-16"
  }, historicalPlan),
  true,
  "A group copied from a later plan must not replace normal orders in a historical saved plan."
);
assert.equal(
  catalogStructureConflictsWithSavedPlan({
    id: "SOA04857-S1",
    type: "SO",
    originalOrderId: "SOA04857",
    dispatchSnapshotSourcePlanId: "52",
    dispatchSnapshotSourcePlanDate: "2026-07-16"
  }, historicalPlan),
  true,
  "A split copied from another plan must not replace its normal parent in a historical saved plan."
);
assert.equal(
  catalogStructureConflictsWithSavedPlan({
    id: "GOA-4857-4893",
    type: "SO",
    childOrders: ["SOA04857", "SOA04893"],
    dispatchSnapshotSourcePlanId: "36",
    dispatchSnapshotSourcePlanDate: "2026-07-10"
  }, historicalPlan),
  false,
  "Structure sourced from the loaded plan itself must remain eligible for restoration."
);
assert.equal(
  catalogStructureConflictsWithSavedPlan({
    id: "GO-UNRELATED",
    type: "SO",
    childOrders: ["SO-NEW-A", "SO-NEW-B"],
    dispatchSnapshotSourcePlanId: "52"
  }, historicalPlan),
  false,
  "An unrelated catalog structure must still be available in the order pool."
);
assert.equal(
  catalogStructureConflictsWithSavedPlan({ id: "SO-NEW", type: "SO" }, historicalPlan),
  false,
  "Ordinary catalog orders must continue to merge into a saved plan."
);
assert.equal(
  catalogStructureConflictsWithSavedPlan({
    id: "GO-LOCAL-DRAFT",
    type: "SO",
    childOrders: ["SOA04857", "SOA04893"]
  }, historicalPlan),
  false,
  "A local group without foreign snapshot provenance must remain eligible for an intentional grouping."
);
for (let index = 0; index < 25; index += 1) {
  const savedRef = `SO-SAVED-${index}`;
  const generatedPlan = { id: `PLAN-${index}`, orders: [{ id: savedRef }] };
  assert.equal(
    catalogStructureConflictsWithSavedPlan({
      id: `GROUP-${index}`,
      childOrders: [savedRef],
      dispatchSnapshotSourcePlanId: `OTHER-${index}`
    }, generatedPlan),
    true,
    "Every foreign group that overlaps a saved normal order must be rejected."
  );
  assert.equal(
    catalogStructureConflictsWithSavedPlan({
      id: `GROUP-DISJOINT-${index}`,
      childOrders: [`SO-OTHER-${index}`],
      dispatchSnapshotSourcePlanId: `OTHER-${index}`
    }, generatedPlan),
    false,
    "Foreign structures disjoint from the saved plan must remain mergeable."
  );
}
const mutationFixtures = [
  {
    catalogOrder: {
      id: "GOA-4857-4893",
      childOrders: ["SOA04857", "SOA04893"],
      dispatchSnapshotSourcePlanId: "52"
    },
    savedPlan: historicalPlan,
    expected: true
  },
  {
    catalogOrder: {
      id: "SOA04857-S1",
      originalOrderId: "SOA04857",
      dispatchSnapshotSourcePlanId: "52"
    },
    savedPlan: historicalPlan,
    expected: true
  },
  {
    catalogOrder: {
      id: "GOA-4857-4893",
      childOrders: ["SOA04857", "SOA04893"],
      dispatchSnapshotSourcePlanId: "36"
    },
    savedPlan: historicalPlan,
    expected: false
  },
  {
    catalogOrder: { id: "GO-LOCAL-DRAFT", childOrders: ["SOA04857"] },
    savedPlan: historicalPlan,
    expected: false
  }
];
const catalogStructureMutants = [
  [
    "accept group overlap",
    [
      "if (groupedRefs.some((ref) => savedOrderIds.has(ref))) return true;",
      "if (false) return true;"
    ]
  ],
  [
    "accept split-parent overlap",
    [
      "return Boolean(parentRef && savedOrderIds.has(parentRef));",
      "return false;"
    ]
  ],
  [
    "reject the loaded plan's own structure",
    ["sourcePlanId === savedPlanId", "sourcePlanId !== savedPlanId"]
  ],
  [
    "treat local drafts as foreign",
    [
      "if (!sourcePlanId || !savedPlanId || sourcePlanId === savedPlanId) return false;",
      "if (!savedPlanId || sourcePlanId === savedPlanId) return false;"
    ]
  ]
];
for (const [name, [before, after]] of catalogStructureMutants) {
  const mutantSource = catalogStructureSource.replace(before, after);
  assert.notEqual(mutantSource, catalogStructureSource, `Mutation setup failed: ${name}`);
  const mutant = Function(`"use strict"; ${mutantSource}; return catalogStructureConflictsWithSavedPlan;`)();
  assert.equal(
    mutationFixtures.some(({ catalogOrder, savedPlan, expected }) => mutant(catalogOrder, savedPlan) !== expected),
    true,
    `Regression suite did not kill mutation: ${name}`
  );
}
const savedPlanRestoreSource = sourceSlice(
  "function applySavedPlan",
  "function compactCurrentPlan",
  "saved-plan restore"
);
assert.match(
  savedPlanRestoreSource,
  /catalogStructureConflictsWithSavedPlan\(order, saved\)/,
  "Saved-plan restoration must apply the catalog structure guard before merging missing orders."
);
const historicalRestore = Function(
  `"use strict";
  let orderCatalog = [
    { id: "SOA04857", type: "SO" },
    { id: "SOA04893", type: "SO" },
    { id: "SOB114411", type: "SO" },
    {
      id: "GOA-4857-4893",
      type: "SO",
      childOrders: ["SOA04857", "SOA04893"],
      dispatchSnapshotSourcePlanId: "52"
    }
  ];
  let orders = [];
  let trucks = [];
  let selectedOrderId = "";
  let selectedOrderIds = new Set();
  let selectedLoadId = "";
  let lastSavedAt = "";
  let lastServerSavedAt = "";
  let lastSavedPlanHash = "";
  function rememberAssignedOrderEvidence() {}
  function clearActiveRouteEstimates() {}
  function activePhysicalOrderEvidence() { return { all: new Set(), pickups: new Set(), drops: new Set() }; }
  function orderMatchesActivityRefs() { return false; }
  function assignedOrderIdsForTrucks() { return new Set(); }
  function isLocalDispatchOrder() { return false; }
  function isNetSuiteDispatchOrder() { return true; }
  function splitParentOrderId(order = {}) { return String(order.originalOrderId || ""); }
  function normalizeOrder(order = {}) {
    return {
      ...order,
      childOrders: [...(order.childOrders || [])],
      childOrderDetails: [...(order.childOrderDetails || [])],
      groupAliases: [...(order.groupAliases || [])]
    };
  }
  function preserveActiveOrderEvidence(_previous, refreshed) { return refreshed; }
  function groupedChildOrderIds(orderList = []) {
    return new Set(orderList.flatMap((order) => [...(order.childOrders || []), ...(order.groupAliases || [])]));
  }
  function splitParentOrderIds(orderList = []) {
    return new Set(orderList.map(splitParentOrderId).filter(Boolean));
  }
  function trucksFromFleetAndSavedPlan(savedTrucks) { return savedTrucks; }
  function normalizeLoadAssignments() {}
  function ensureDriverLaneOrder() {}
  function defaultDriverLaneOrder() { return []; }
  function reconcileTransitCoSourceOrders() {}
  function reapplyActiveOrderEvidence(list) { return list; }
  function expandScmGroupedPoStops() {}
  function collapseGroupedOrderStops() {}
  function syncPickupStops() {}
  function cleanupOrphanPickupStops() {}
  function reconcilePickupStopRepresentatives() {}
  function forecastMatchesCurrentPlan() { return true; }
  function clearDispatchForecast() {}
  function savedPlanHash() { return "saved"; }
  ${catalogStructureSource}
  ${savedPlanRestoreSource}
  const saved = ${JSON.stringify(historicalPlan)};
  saved.trucks = [];
  const applied = applySavedPlan(saved);
  return { applied, ids: orders.map((order) => order.id) };`
)();
assert.equal(historicalRestore.applied, true);
assert.deepEqual(
  historicalRestore.ids,
  ["SOA04857", "SOA04893", "SOB114411"],
  "Opening the July 10 plan must not inject the later GOA group or hide its historical child orders."
);

const fingerprintSource = sourceSlice("function compactStringFingerprint", "function payloadRequiresSave", "compact save fingerprint helpers");
const makeFingerprintHelpers = Function(
  "currentPlanDate",
  "currentPlan",
  `"use strict"; ${fingerprintSource}; return { compactStringFingerprint, stablePlanHashPayload, savedPlanHash };`
);
const fingerprints = makeFingerprintHelpers("2026-07-23", { id: "plan-1" });

const largeText = "dispatch-payload:" + "x".repeat(1024 * 1024);
const largeFingerprint = fingerprints.compactStringFingerprint(largeText);
assert.equal(largeFingerprint, fingerprints.compactStringFingerprint(largeText), "Fingerprints must be deterministic.");
assert.notEqual(largeFingerprint, fingerprints.compactStringFingerprint(`${largeText}!`), "A payload mutation must change its fingerprint.");
assert.ok(largeFingerprint.length < 64, "The saved fingerprint must remain compact even for a one-megabyte payload.");
assert.ok(largeFingerprint.startsWith(`${largeText.length.toString(36)}:`), "The compact fingerprint must retain the source length as collision evidence.");

const basePayload = {
  planId: "plan-1",
  planDate: "2026-07-23",
  orders: [{ id: "SO1", qty: 1 }],
  trucks: [{ id: "T1", loads: [] }],
  summary: { driverLaneOrder: ["driver-a"] }
};
const baseHash = fingerprints.stablePlanHashPayload(basePayload);
assert.equal(baseHash, fingerprints.stablePlanHashPayload(structuredClone(basePayload)));
assert.notEqual(baseHash, fingerprints.stablePlanHashPayload({ ...basePayload, orders: [{ id: "SO1", qty: 2 }] }), "Order changes must invalidate the save hash.");
assert.notEqual(baseHash, fingerprints.stablePlanHashPayload({ ...basePayload, trucks: [{ id: "T2", loads: [] }] }), "Truck/load changes must invalidate the save hash.");
assert.notEqual(baseHash, fingerprints.stablePlanHashPayload({ ...basePayload, summary: { driverLaneOrder: ["driver-b"] } }), "Lane sequence changes must invalidate the save hash.");

const errorReporterSource = sourceSlice("function reportDispatchSaveError", "function minutes", "browser save error reporter");
const makeErrorReporter = Function(
  "console",
  "currentPlan",
  "currentPlanDate",
  "dispatchSessionId",
  `"use strict"; ${errorReporterSource}; return reportDispatchSaveError;`
);
const errors = [];
const reportDispatchSaveError = makeErrorReporter(
  { error: (...args) => errors.push(args) },
  { id: "plan-7", revision: 19 },
  "2026-07-23",
  "session-3"
);
const originalError = new Error("quota or network failure");
reportDispatchSaveError("exception", originalError, { status: 503, retryOnStale: false });
assert.equal(errors.length, 1);
assert.equal(errors[0][0], "[dispatch-save]");
assert.deepEqual(errors[0][1], {
  event: "exception",
  planId: "plan-7",
  planDate: "2026-07-23",
  revision: 19,
  sessionId: "session-3",
  message: "quota or network failure",
  status: 503,
  retryOnStale: false
});
assert.equal(errors[0][2], originalError, "The original Error must remain available for a browser-console stack trace.");

const queueSource = sourceSlice("async function flushPlanSaveQueue", "function historySnapshot", "serialized plan-save queue");
assert.match(queueSource, /if \(saveInFlight\)[\s\S]*?saveQueued\s*=\s*true;[\s\S]*?return saveFlushPromise;/, "A concurrent flush must join the active save and preserve a queued follow-up.");
assert.match(queueSource, /while \(saveQueued\)/, "Queued mutations must be drained serially.");
assert.match(queueSource, /const saveGeneration\s*=\s*localPlanGeneration;/, "Each payload must capture its local edit generation.");
assert.match(queueSource, /await savePlanToServer\(payload,[\s\S]*?saveGeneration[\s\S]*?\);/, "The captured generation must travel with the awaited save.");
assert.match(queueSource, /const forceSave\s*=\s*forceNextPlanSave;[\s\S]*?forceNextPlanSave\s*=\s*false;/, "Save Now must consume a one-shot force flag inside the serialized queue.");
assert.match(queueSource, /forceSave[\s\S]*?await savePlanToServer\(payload,[\s\S]*?forceSave/, "The serialized queue must forward the Save Now force flag to the server.");
assert.match(queueSource, /return finalResult;/, "The queue must return the actual final save result to Save Now.");
assert.doesNotMatch(queueSource, /Promise\.all/, "Plan writes must never race through Promise.all.");
assert.match(queueSource, /activeSaveGeneration\s*=\s*saveGeneration;/,
  "The save queue must expose which local generation the active request is already persisting.");
assert.match(queueSource, /finally\s*{\s*activeSaveGeneration\s*=\s*null;/,
  "The active save generation must be cleared even when a request fails.");

const saveNowSource = sourceSlice("async function saveCurrentPlanNow", "async function forceSaveCurrentPlan", "Save Now in-flight coordination");
assert.match(saveNowSource, /!localPlanDirty\s*&&\s*!saveQueued\s*&&\s*!saveInFlight/,
  "Save Now must return immediately when the current plan is already durably saved.");
assert.match(saveNowSource, /activeSaveGeneration\s*===\s*localPlanGeneration[\s\S]*?await saveFlushPromise/,
  "Save Now must join an autosave of the same generation instead of issuing a duplicate forced save.");
assert.match(saveNowSource, /if \(!joinsCurrentGeneration\)[\s\S]*?forceNextPlanSave\s*=\s*true/,
  "A genuine unsaved generation must retain the explicit one-shot Save Now behavior.");

const makeBlockedSaveQueueFixture = Function(
  `"use strict";
  let saveTimer = null;
  let saveInFlight = false;
  let saveQueued = true;
  let saveFlushPromise = null;
  let activeSaveGeneration = null;
  let forceNextPlanSave = false;
  let localPlanGeneration = 1;
  let lastSavedAt = "";
  let isApplyingRemotePlan = false;
  let firstSaveStartedResolve;
  let firstSaveResponseResolve;
  const firstSaveStarted = new Promise((resolve) => { firstSaveStartedResolve = resolve; });
  const firstSaveResponse = new Promise((resolve) => { firstSaveResponseResolve = resolve; });
  const saveGenerations = [];
  const clearedGenerations = [];
  function isDispatchPlanEditor() { return true; }
  function autosaveDebug() {}
  function shortHash(value) { return String(value || ""); }
  function planPayload(savedAt) {
    return { generation: localPlanGeneration, savedAt: savedAt.toISOString(), baseRevision: localPlanGeneration };
  }
  function stablePlanHashPayload(payload) { return String(payload.generation); }
  function payloadRequiresSave() { return true; }
  function clearLocalPlanDirty(_savedAt, generation) { clearedGenerations.push(generation); }
  async function savePlanToServer(_payload, { saveGeneration }) {
    saveGenerations.push(saveGeneration);
    if (saveGenerations.length === 1) {
      firstSaveStartedResolve();
      return firstSaveResponse;
    }
    return { saved: true, latest: true };
  }
  ${queueSource}
  return {
    flushPlanSaveQueue,
    firstSaveStarted,
    queueNewerMutation() {
      localPlanGeneration += 1;
      saveQueued = true;
    },
    resolveFirstAsBlocked() {
      firstSaveResponseResolve({ blocked: true, code: "DISPATCH_ORDER_DEPENDENCY_INVALID" });
    },
    state() {
      return { saveGenerations: [...saveGenerations], clearedGenerations: [...clearedGenerations], saveQueued, saveInFlight };
    }
  };`
);
const blockedSaveQueue = makeBlockedSaveQueueFixture();
const blockedSaveFlush = blockedSaveQueue.flushPlanSaveQueue();
await blockedSaveQueue.firstSaveStarted;
blockedSaveQueue.queueNewerMutation();
blockedSaveQueue.resolveFirstAsBlocked();
const blockedSaveResult = await blockedSaveFlush;
assert.deepEqual(
  blockedSaveQueue.state().saveGenerations,
  [1, 2],
  "A rejected older grouped save must not strand the newer ungroup mutation in the queue."
);
assert.equal(blockedSaveResult?.saved, true, "The flush result must reflect the newer successful ungroup save.");
assert.equal(blockedSaveQueue.state().saveQueued, false, "The newer generation must be drained instead of remaining queued until hard refresh.");
assert.equal(blockedSaveQueue.state().saveInFlight, false, "The serialized save queue must leave its in-flight state after draining.");

const dirtySource = sourceSlice("function markLocalPlanDirty", "function resetLocalPlanDirty", "local save-generation guards");
assert.match(dirtySource, /localPlanGeneration\s*\+=\s*1/, "Every local mutation must advance the generation.");
assert.match(dirtySource, /if \(savedGeneration !== localPlanGeneration\) return;/, "An older response must not clear newer local edits.");
assert.match(dirtySource, /new Date\(savedAt\) < new Date\(lastLocalPlanEditAt\)/, "A response older than the latest edit must not clear the dirty flag.");

const saveSource = sourceSlice("async function savePlanToServer", "function queueServerSave", "plan save response coordination");
assert.match(saveSource, /const savedLatestLocal\s*=\s*saveGeneration\s*===\s*localPlanGeneration;/, "Save completion must be compared with the latest local generation.");
assert.match(saveSource, /if \(savedLatestLocal\)[\s\S]*?clearLocalPlanDirty\([^;]*saveGeneration\);[\s\S]*?else\s*{\s*saveQueued\s*=\s*true;/, "A superseded save must queue a new save instead of clearing local state.");
assert.match(saveSource, /minimumPlanRevisionToApply\.planId[\s\S]*?===\s*String\(targetPlanId\)/, "The minimum accepted revision must be scoped to the plan being saved.");
assert.match(saveSource, /resultRevision\s*<\s*guardedRevision/, "A response older than the guarded revision must be ignored.");

const confirmSource = sourceSlice("async function confirmCurrentPlanAtomic", "function commitPlanMutation", "confirm revision hand-off");
assert.match(confirmSource, /minimumPlanRevisionToApply\s*=\s*{\s*planId:\s*String\(plan\.id\s*\|\|\s*""\),\s*revision:\s*Number\(plan\.revision\s*\|\|\s*0\)\s*}/, "Confirmation must establish a per-plan minimum revision before older autosaves can return.");

const restoreSource = sourceSlice("async function restoreServerPlan", "async function pollServerPlan", "remote-newer restore guard");
assert.match(restoreSource, /const requestedPlanId\s*=\s*currentPlan\.id;/, "Restore must pin the requested plan before awaiting the server.");
assert.match(restoreSource, /fetch\(`\/api\/dispatch\/plans\/\$\{encodeURIComponent\(requestedPlanId\)}`\)/, "Restore must fetch the pinned plan identifier.");
assert.match(restoreSource, /const newerRevision\s*=\s*savedRevision\s*>\s*localRevision;/, "Restore must compare server and local revisions.");
assert.match(restoreSource, /const newerSavedAt\s*=/, "Restore must also compare save timestamps for same-revision updates.");
assert.match(restoreSource, /if \(!newerRevision && !newerSavedAt\) return false;/, "Only a genuinely newer server plan may replace the local view.");

const liveEventSource = sourceSlice("function connectEvents", "function findLoad", "dispatch live-event coordination");
const planEventSource = liveEventSource.slice(liveEventSource.indexOf('if (["dispatch.plan.saved"'));
assert.match(planEventSource, /pollServerPlan\(\);/, "A plan event must verify the server revision before refreshing or warning.");
assert.doesNotMatch(planEventSource.slice(0, planEventSource.indexOf('if (event.type === "dispatch.setup.updated")')), /sse:blockedByDirty|Remote update available/,
  "A source event alone must not claim that another editor changed the plan.");

const linkModalResetSource = sourceSlice(
  "function resetActiveLinkModalState",
  "function renderActiveLinkModalInPlace",
  "plan-scoped Link modal reset"
);
assert.match(linkModalResetSource, /orderDependencyAbortController\?\.abort\(\)/,
  "Switching plans must abort a stale Link TO request.");
assert.match(linkModalResetSource, /orderDependencyRequestSequence\s*\+=\s*1/,
  "Switching plans must invalidate an already-returning Link TO request.");
const planLoadSource = sourceSlice("async function loadPlanForDate", "async function restoreServerPlan", "plan switching");
assert.match(planLoadSource, /resetActiveLinkModalState\(\)/,
  "Loading another plan date must close its plan-scoped Link modal.");
const unlinkActionSource = sourceSlice(
  'if (action === "unlink-dependency")',
  'if (action === "undo-plan")',
  "dependency unlink action"
);
assert.match(unlinkActionSource, /removeLocalOrderDependency\(dependencyId\)/,
  "A successful unlink must remove the stale dependency from local grouped-order copies immediately.");
assert.doesNotMatch(unlinkActionSource, /loadOrderDependencyOptions/,
  "A successful unlink must not resurrect a stale grouped dependency through an immediate failing refresh.");
const groupOrderSource = sourceSlice("function groupOrder", "function groupedDispatchOrderId", "group plan ownership");
assert.match(groupOrderSource, /groupPlanId:\s*currentPlan\?\.id/,
  "A local group must retain the plan that owns its dependency structure.");
assert.match(groupOrderSource, /groupPlanDate:\s*currentPlanDate/,
  "A local group must retain its owning plan date.");
const openToLinkSource = sourceSlice(
  'if (action === "open-to-link-modal")',
  'if (action === "order-type-tab")',
  "Link TO modal ownership guard"
);
assert.match(openToLinkSource, /belongs to the \$\{groupPlanDate \|\| "other"\} plan/,
  "A grouped order copied from another plan must block dependency mutation until its owning plan is loaded.");
assert.match(openToLinkSource, /groupPlanId\s*!==\s*currentPlanId/,
  "A grouped order copied from another same-date plan must be blocked by its owning plan id.");
const dependencyLinksSource = sourceSlice(
  "function renderDependencyLinks",
  "function renderToLinkModal",
  "unavailable dependency controls"
);
assert.match(dependencyLinksSource, /unlinkOnly\s*\?\s*""\s*:\s*`<select/,
  "An unavailable grouped target must hide dependency mode controls and remain unlink-only.");
const dependencyLinkRenderSource = sourceSlice(
  "function renderToLinkModal",
  "function renderPoLinkMatchBoard",
  "dependency link rendering"
);
assert.match(dependencyLinkRenderSource, /unlinkOnly:\s*options\.targetUnavailable\s*===\s*true/,
  "The Link TO modal must enable unlink-only rendering when the server cannot resolve its target.");

for (const eventName of ["conflict", "server-response", "saved-with-followup-warning", "exception"]) {
  assert.match(saveSource, new RegExp(`reportDispatchSaveError\\(\\s*"${eventName}"`), `The ${eventName} path must report actionable details in the browser console.`);
}

const serverSource = await readFile(new URL("./server.js", import.meta.url), "utf8");
const dateValidationStart = serverSource.indexOf("async function findNewDispatchPlanDateConflicts");
const dateValidationEnd = serverSource.indexOf("function dispatchDateCompare", dateValidationStart);
const dateValidationSource = serverSource.slice(dateValidationStart, dateValidationEnd);
assert.ok(dateValidationStart >= 0 && dateValidationEnd > dateValidationStart, "Expected incremental plan-date validation source was not found.");
assert.match(dateValidationSource, /newlyPlannedRefs[\s\S]*?if \(!newlyPlannedRefs\.size\) return \[\];/,
  "An ordinary edit must not reload every historical plan when it adds no new order assignment.");
assert.doesNotMatch(dateValidationSource, /previousConflicts/,
  "Date validation must not load the complete historical snapshot set twice.");
assert.match(dateValidationSource, /inferredParentRef[\s\S]*?replace\(\/-S\\d\+\$\/i, ""\)/,
  "Incremental date validation must preserve legacy split-parent identity.");
const coValidationStart = serverSource.indexOf("async function findChangedDispatchCoSequenceConflicts");
const coValidationEnd = serverSource.indexOf("function sendDispatchPlanDateConflictResponse", coValidationStart);
const coValidationSource = serverSource.slice(coValidationStart, coValidationEnd);
assert.ok(coValidationStart >= 0 && coValidationEnd > coValidationStart, "Expected changed-CO validation source was not found.");
assert.match(coValidationSource, /nextPlan\.orders[\s\S]*?transitCo[\s\S]*?return \[\];/,
  "Plans without transit CO dependencies must skip cross-plan CO validation.");
const coRowsStart = serverSource.indexOf("async function dispatchPlansForCoValidation");
const coRowsEnd = serverSource.indexOf("async function findDispatchCoSequenceConflicts", coRowsStart);
const coRowsSource = serverSource.slice(coRowsStart, coRowsEnd);
assert.match(coRowsSource, /SELECT DISTINCT ON[\s\S]*?AS co_ref[\s\S]*?AS finish/,
  "Cross-plan CO validation must fetch compact occurrence rows.");
assert.doesNotMatch(coRowsSource, /s\.orders,\s*s\.trucks/,
  "Cross-plan CO validation must not transfer complete historical plan snapshots.");
const saveEndpointStart = serverSource.indexOf('app.put("/api/dispatch/plans/:id"');
const saveEndpointEnd = serverSource.indexOf('app.post("/api/dispatch/plans/:id/confirm"', saveEndpointStart);
const saveEndpointSource = serverSource.slice(saveEndpointStart, saveEndpointEnd);
assert.match(serverSource, /function reportDispatchSaveTiming[\s\S]*?\[dispatch-save-timing\][\s\S]*?durationMs/,
  "Dispatch saves must emit a measured server duration for launch monitoring.");
assert.ok(
  saveEndpointSource.indexOf("dispatchLoadAssignmentConflicts") < saveEndpointSource.indexOf("findNewDispatchPlanDateConflicts"),
  "A protected started-stop edit must fail before any cross-plan validation query."
);

const repositorySource = await readFile(new URL("./dispatch-plan-repository.js", import.meta.url), "utf8");
const customValidationStart = repositorySource.indexOf("async function assertCustomOrderPlanDateExclusivity");
const customValidationEnd = repositorySource.indexOf("function collectPlanOrderRefs", customValidationStart);
const customValidationSource = repositorySource.slice(customValidationStart, customValidationEnd);
assert.match(customValidationSource, /previousRefs[\s\S]*?filter\(\(ref\) => !previousRefs\.has\(ref\)\)[\s\S]*?if \(!customRefs\.length\) return;/,
  "Unchanged custom-order placement must not rescan every historical plan during an ordinary save.");

console.log("Dispatch save coordination and browser diagnostics checks passed.");
