import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(process.env.DISPATCH_SEARCH_SOURCE || new URL("../../../public/dispatch.js", import.meta.url), "utf8");
const start = source.indexOf("function dispatchOrderFeedRequest(");
const end = source.indexOf("\nfunction timeText(", start);
assert.ok(start > 0 && end > start);

test("request context and encoded inputs round-trip without crossing history/view boundaries", () => {
  const context = vm.createContext({ URLSearchParams, history: true, currentPlanDate: "2026-01-01",
    dispatchSessionId: "", planEditLeaseToken: "lease", isDispatchHistoryEditMode() { return this.history; } });
  // The production helper calls the supplied boundary as an ordinary function.
  vm.runInContext(`function isDispatchHistoryEditMode() { return history; }\n${source.slice(start, end)}`, context);
  let state = 20260930;
  for (let index = 0; index < 128; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    context.dispatchSessionId = `tab-${state.toString(36)} &?=/#汉字`;
    const search = `TOB0116${index % 2 ? "3" : "4"} &sessionId=wrong ? +#汉字`;
    const cursor = `${state}?&limit=0`;
    for (const history of [true, false]) {
      context.history = history;
      for (const versioned of [true, false]) {
        const request = context.dispatchOrderFeedRequest({ search, versioned, type: "TO", cursor });
        const url = new URL(request.url, "http://dispatch.test");
        assert.equal(url.pathname, versioned ? "/api/dispatch/v2/order-pool" : "/api/dispatch/orders");
        assert.equal(url.searchParams.get("search"), search);
        assert.equal(url.searchParams.getAll("search").length, 1);
        assert.equal(url.searchParams.get("sessionId"), history ? context.dispatchSessionId : null);
        assert.equal(url.searchParams.get("historyPlanDate"), history ? context.currentPlanDate : null);
        assert.equal(request.headers["x-dispatch-edit-lease"], history ? context.planEditLeaseToken : undefined);
        if (versioned) {
          assert.equal(url.searchParams.get("type"), "TO");
          assert.equal(url.searchParams.get("cursor"), cursor);
          assert.equal(url.searchParams.get("limit"), "200");
        } else {
          assert.equal(url.searchParams.has("type"), false);
          assert.equal(url.searchParams.has("cursor"), false);
        }
      }
      const sync = context.dispatchOrderFeedRequest({ sync: true, versioned: true });
      const syncUrl = new URL(sync.url, "http://dispatch.test");
      assert.equal(syncUrl.pathname, "/api/dispatch/sync");
      assert.equal(syncUrl.searchParams.get("sessionId"), history ? context.dispatchSessionId : null);
    }
  }
});
