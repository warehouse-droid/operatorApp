import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");
const start = source.indexOf('const DISPATCH_PLAN_CACHE_KEY = "mbbs.dispatch.plan";');
const end = source.indexOf("const DISPATCH_SESSION_KEY", start);
assert.ok(start >= 0 && end > start, "Dispatch storage helpers must remain available.");

const helpers = Function("window", `${source.slice(start, end)}; return {
  DISPATCH_PLAN_CACHE_KEY,
  dispatchStorageGet,
  dispatchStorageSet,
  dispatchStorageRemove
};`);

function storageMock({ initial = {}, throwOnGet = false, throwOnSet = false } = {}) {
  const values = new Map(Object.entries(initial));
  let setCalls = 0;
  return {
    values,
    get setCalls() { return setCalls; },
    getItem(key) {
      if (throwOnGet) throw new DOMException("Storage blocked", "SecurityError");
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      setCalls += 1;
      if (throwOnSet) throw new DOMException("Quota exceeded", "QuotaExceededError");
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

const legacyStorage = storageMock({ initial: { "mbbs.dispatch.plan": "oversized legacy plan" } });
const legacy = helpers({ localStorage: legacyStorage });
assert.equal(legacyStorage.values.has(legacy.DISPATCH_PLAN_CACHE_KEY), false, "Legacy full-plan cache must be cleared at startup.");
assert.equal(legacy.dispatchStorageGet(legacy.DISPATCH_PLAN_CACHE_KEY, "server-plan"), "server-plan", "Plans must never hydrate from localStorage.");
assert.equal(legacy.dispatchStorageSet(legacy.DISPATCH_PLAN_CACHE_KEY, "new oversized plan"), false, "Plans must never be written to localStorage.");
assert.equal(legacyStorage.setCalls, 0, "Skipping the plan cache must happen before setItem is called.");

const fullStorage = storageMock({ throwOnSet: true });
const full = helpers({ localStorage: fullStorage });
assert.doesNotThrow(() => full.dispatchStorageSet("mbbs.dispatch.planDate", "2026-07-22"));
assert.equal(full.dispatchStorageSet("mbbs.dispatch.planDate", "2026-07-22"), false, "A full origin must not interrupt server plan saves or confirmation.");

const blockedStorage = storageMock({ throwOnGet: true });
const blocked = helpers({ localStorage: blockedStorage });
assert.equal(blocked.dispatchStorageGet("mbbs.dispatch.planDate", "fallback"), "fallback", "Blocked storage must fall back without interrupting plan load.");

console.log("Dispatch storage quota checks passed.");
