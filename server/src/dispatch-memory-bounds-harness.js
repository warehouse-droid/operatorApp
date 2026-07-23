import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker, description = startMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected ${description} source was not found.`);
  return source.slice(start, end);
}

const fingerprintSource = sourceSlice("function compactStringFingerprint", "function stablePlanHashPayload", "history fingerprint helper");
const historySource = sourceSlice("function packHistorySnapshot", "function resetUndoHistory", "packed bounded history helpers");
const makeHistoryHarness = Function(
  "HISTORY_LIMIT",
  "HISTORY_MEMORY_LIMIT_BYTES",
  `"use strict";
   let undoStack = [];
   let redoStack = [];
   const historySnapshot = () => ({});
   ${fingerprintSource}
   ${historySource}
   return {
     packHistorySnapshot,
     unpackHistorySnapshot,
     historySnapshotFingerprint,
     trimHistoryMemory,
     setStacks(undo, redo) { undoStack = undo; redoStack = redo; },
     getStacks() { return { undoStack, redoStack }; }
   };`
);
const HISTORY_LIMIT = 20;
const HISTORY_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const history = makeHistoryHarness(HISTORY_LIMIT, HISTORY_MEMORY_LIMIT_BYTES);

const originalSnapshot = { orders: [{ id: "SO1", qty: 1 }], trucks: [{ id: "T1", loads: [] }], driverLaneOrder: ["driver-a"] };
const packed = history.packHistorySnapshot(originalSnapshot);
assert.equal(typeof packed, "string", "History entries must be stored as packed strings, not duplicate live object graphs.");
originalSnapshot.orders[0].qty = 99;
assert.equal(history.unpackHistorySnapshot(packed).orders[0].qty, 1, "A packed undo point must be isolated from later live mutations.");
assert.equal(history.historySnapshotFingerprint(history.unpackHistorySnapshot(packed)), history.historySnapshotFingerprint(history.unpackHistorySnapshot(packed)), "Packed history fingerprints must be deterministic.");

history.setStacks(
  Array.from({ length: 31 }, (_, index) => JSON.stringify({ side: "undo", index })),
  Array.from({ length: 27 }, (_, index) => JSON.stringify({ side: "redo", index }))
);
history.trimHistoryMemory();
let stacks = history.getStacks();
assert.equal(stacks.undoStack.length, HISTORY_LIMIT, "Undo history must retain no more than the configured entry limit.");
assert.equal(stacks.redoStack.length, HISTORY_LIMIT, "Redo history must retain no more than the configured entry limit.");
assert.ok([...stacks.undoStack, ...stacks.redoStack].every((entry) => typeof entry === "string"));
assert.match(stacks.undoStack[0], /"index":11/, "The history limit must discard the oldest undo points first.");
assert.match(stacks.redoStack[0], /"index":7/, "The history limit must discard the oldest redo points first.");

const largeEntry = (index) => JSON.stringify({ index, blob: "x".repeat(5 * 1024 * 1024) });
history.setStacks([largeEntry(0), largeEntry(1)], [largeEntry(2), largeEntry(3)]);
history.trimHistoryMemory();
stacks = history.getStacks();
const retainedBytes = [...stacks.undoStack, ...stacks.redoStack]
  .reduce((sum, entry) => sum + (entry.length * 2), 0);
assert.ok(retainedBytes <= HISTORY_MEMORY_LIMIT_BYTES, "Packed undo/redo content must stay under the aggregate memory budget.");
assert.ok(stacks.undoStack.length + stacks.redoStack.length >= 1, "Trimming must retain at least one recoverable snapshot.");

const compactPlanSource = sourceSlice("function compactCurrentPlan", "async function savePlanToServer", "compact current-plan helper");
const compactCurrentPlan = Function(`"use strict"; ${compactPlanSource}; return compactCurrentPlan;`)();
const fullPlan = {
  id: "plan-1",
  planDate: "2026-07-23",
  revision: 8,
  status: "draft",
  orders: Array.from({ length: 100 }, (_, index) => ({ id: `SO${index}` })),
  trucks: Array.from({ length: 10 }, (_, index) => ({ id: `T${index}`, loads: [] }))
};
assert.deepEqual(compactCurrentPlan(fullPlan), {
  id: "plan-1",
  planDate: "2026-07-23",
  revision: 8,
  status: "draft"
}, "currentPlan must retain metadata without duplicating the large orders/trucks graphs.");
assert.equal(compactCurrentPlan(null), null);

const boundedCacheSource = sourceSlice("function boundedPersistedRouteEstimateCache", "function loadPersistedRouteEstimateCache", "bounded route-estimate cache helper");
const makeBoundedCache = Function(
  "ROUTE_ESTIMATE_CACHE_LIMIT",
  "ROUTE_ESTIMATE_CACHE_MAX_CHARS",
  "ROUTE_ESTIMATE_CACHE_MAX_AGE_MS",
  `"use strict"; ${boundedCacheSource}; return boundedPersistedRouteEstimateCache;`
);
const ROUTE_ESTIMATE_CACHE_LIMIT = 100;
const ROUTE_ESTIMATE_CACHE_MAX_CHARS = 500000;
const ROUTE_ESTIMATE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const boundedCache = makeBoundedCache(
  ROUTE_ESTIMATE_CACHE_LIMIT,
  ROUTE_ESTIMATE_CACHE_MAX_CHARS,
  ROUTE_ESTIMATE_CACHE_MAX_AGE_MS
);

const now = Date.parse("2026-07-23T12:00:00.000Z");
const manyEntries = {};
for (let index = 0; index < 130; index += 1) {
  manyEntries[`route-${index}`] = {
    savedAt: new Date(now - (index * 60000)).toISOString(),
    estimate: { driveMinutes: index + 1 }
  };
}
manyEntries.expired = {
  savedAt: new Date(now - ROUTE_ESTIMATE_CACHE_MAX_AGE_MS - 1).toISOString(),
  estimate: { driveMinutes: 1 }
};
manyEntries.future = {
  savedAt: new Date(now + 300001).toISOString(),
  estimate: { driveMinutes: 1 }
};
manyEntries.invalid = { savedAt: new Date(now).toISOString() };
const countBounded = boundedCache(manyEntries, now);
assert.equal(Object.keys(countBounded).length, ROUTE_ESTIMATE_CACHE_LIMIT, "The persistent route cache must be capped by entry count.");
assert.ok(countBounded["route-0"], "The newest route estimate must survive count trimming.");
assert.ok(!countBounded["route-129"], "The oldest excess route estimate must be discarded.");
assert.ok(!countBounded.expired && !countBounded.future && !countBounded.invalid, "Expired, future-dated, and invalid cache records must be rejected.");

const bulkyEntries = {};
for (let index = 0; index < 20; index += 1) {
  bulkyEntries[`bulky-${index}`] = {
    savedAt: new Date(now - index).toISOString(),
    estimate: { encodedRoute: `${index}:` + "r".repeat(60000) }
  };
}
const charBounded = boundedCache(bulkyEntries, now);
assert.ok(JSON.stringify(charBounded).length <= ROUTE_ESTIMATE_CACHE_MAX_CHARS, "The persistent route cache must remain below its storage character budget.");
assert.ok(Object.keys(charBounded).length < Object.keys(bulkyEntries).length, "The character limit must actively trim bulky estimates.");

const persistedCacheSource = sourceSlice("function flushPersistedRouteEstimateCache", "function routeEstimateId", "debounced persistent route-cache writer");
const makePersistedCacheHarness = Function(
  "window",
  "boundedPersistedRouteEstimateCache",
  "dispatchStorageSet",
  "dispatchStorageRemove",
  "ROUTE_ESTIMATE_STORAGE_KEY",
  `"use strict";
   let persistedRouteEstimateCache = {};
   let persistedRouteEstimateSaveTimer = null;
   ${persistedCacheSource}
   return {
     savePersistedRouteEstimateCache,
     setCache(cache) { persistedRouteEstimateCache = cache; },
     getTimer() { return persistedRouteEstimateSaveTimer; }
   };`
);
let nextTimerId = 1;
const activeTimers = new Map();
const clearedTimers = [];
const writes = [];
const removals = [];
const fakeWindow = {
  setTimeout(callback, delay) {
    const id = nextTimerId++;
    activeTimers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) {
    if (id !== null && id !== undefined) clearedTimers.push(id);
    activeTimers.delete(id);
  }
};
const persisted = makePersistedCacheHarness(
  fakeWindow,
  boundedCache,
  (key, value) => {
    writes.push({ key, value });
    return true;
  },
  (key) => removals.push(key),
  "mbbs.dispatch.routeEstimates.v1"
);
persisted.setCache({ latest: manyEntries["route-0"] });
persisted.savePersistedRouteEstimateCache();
const firstTimer = persisted.getTimer();
persisted.savePersistedRouteEstimateCache();
const secondTimer = persisted.getTimer();
assert.notEqual(firstTimer, secondTimer, "A newer cache mutation must replace the pending write timer.");
assert.ok(clearedTimers.includes(firstTimer), "The replaced cache timer must be cancelled.");
assert.equal(activeTimers.size, 1, "Repeated cache changes must coalesce into one pending storage write.");
assert.equal(activeTimers.get(secondTimer).delay, 500, "Persistent route-cache writes must use the intended debounce window.");
assert.equal(writes.length, 0, "The cache must not write synchronously on every route calculation.");
activeTimers.get(secondTimer).callback();
assert.equal(writes.length, 1, "The coalesced timer must perform exactly one storage write.");
assert.equal(removals.length, 0);
assert.ok(writes[0].value.length <= ROUTE_ESTIMATE_CACHE_MAX_CHARS);

const renderSource = sourceSlice("function render(options = {})", "function renderOrderCard", "main dispatch render loop");
assert.match(renderSource, /const planChanged\s*=\s*\(!historyReady \|\| save\)\s*\?\s*captureUndoPointIfNeeded\(save\)\s*:\s*false;/, "Ordinary UI renders must not serialize the full plan into history.");
assert.doesNotMatch(source, /function cloneHistoryValue/, "The old recursive per-render history clone must not return.");
assert.doesNotMatch(source, /structuredClone\(/, "Dispatch rendering must not deep-clone the plan graph.");

const historySnapshotSource = sourceSlice("function historySnapshot", "function packHistorySnapshot", "lightweight live history snapshot");
assert.doesNotMatch(historySnapshotSource, /JSON\.parse|JSON\.stringify|structuredClone/, "Building a live history snapshot must not deep-clone orders or trucks.");

const backgroundDebounceSource = sourceSlice("function scheduleBackgroundRouteEstimates", "async function runBackgroundRouteEstimates", "background route debounce");
assert.match(backgroundDebounceSource, /clearTimeout\(backgroundRouteTimer\)/, "A pending background estimate batch must be cancelled before rescheduling.");
assert.match(backgroundDebounceSource, /setTimeout\(runBackgroundRouteEstimates,\s*650\)/, "Background route estimates must be debounced.");

console.log("Dispatch memory, history, and route-cache bounds checks passed.");
