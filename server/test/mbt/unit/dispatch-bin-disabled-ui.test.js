import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "espree";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);

test("P3 compatibility: closed BIN gates preserve the established Dispatch order pool and make no BIN feed request", () => {
  assert.match(dispatchSource, /let\s+mbtBinDispatchEnabled\s*=\s*false\s*;/u);
  assert.match(
    dispatchSource,
    /async\s+function\s+loadMbtBinDispatchCapability\([^)]*\)[\s\S]{0,1200}\/api\/mbt\/status[\s\S]{0,1200}capabilities\?\.binDispatch\?\.enabled\s*===\s*true/u
  );
  assert.match(
    dispatchSource,
    /async\s+function\s+loadMbtBinFrontLegs\([^)]*\)\s*\{[\s\S]{0,500}if\s*\(\s*!mbtBinDispatchEnabled\s*\)[\s\S]{0,500}return\s+false\s*;[\s\S]{0,800}fetch\(`/u,
    "The disabled guard must return before the BIN feed fetch."
  );
  assert.match(
    dispatchSource,
    /\[\s*"SO"\s*,\s*"PO"\s*,\s*"TO"\s*,\s*"CO"\s*\]\.map\(\(type\)\s*=>/u,
    "The ordinary order-pool tabs must retain their established shape."
  );
  assert.doesNotMatch(
    dispatchSource,
    /mbtBinDispatchEnabled\s*\?\s*`<button[\s\S]{0,500}data-type="BIN"[\s\S]{0,500}:\s*""/u,
    "BIN assignment belongs on the separate MBT planning page."
  );
});

test("Dispatch renders independently without requesting MBT capability or pool data", async () => {
  const declarations = parse(dispatchSource, { ecmaVersion: "latest", sourceType: "script", range: true }).body;
  for (const enabled of [false, true]) {
    const events = [];
    const context = vm.createContext({
      console, URLSearchParams,
      currentPlanDate: "2026-09-17", activeOrderType: "SO", searchText: "",
      mbtBinDispatchEnabled: false, mbtBinDispatchRequestSequence: 0,
      window: { requestAnimationFrame: () => {}, setTimeout: () => {} },
      render: () => events.push("render"), connectEvents: () => events.push("connected"),
      loadDispatchConfig: async () => {}, loadDispatchSetup: async () => {},
      loadDispatchVendorYards: async () => {}, loadPlanForDate: async (_date, { setupReady }) => { await setupReady; events.push("snapshot"); },
      scheduleDispatchForecastPolling: () => {}, setInterval: () => {}, pollServerPlan: () => {},
      fetch: async (url) => {
        if (url === "/api/mbt/status") {
          events.push("capability");
          return { ok: true, json: async () => ({ capabilities: { binDispatch: { enabled } } }) };
        }
        assert.match(url, /^\/api\/mbt\/dispatch\/front-legs\?/u);
        events.push("feed");
        return { ok: true, json: async () => ({ items: [] }) };
      }
    });
    for (const name of ["initDispatch", "loadMbtBinDispatchCapability", "loadMbtBinFrontLegs"]) {
      const declaration = declarations.find((node) => node.type === "FunctionDeclaration" && node.id.name === name);
      assert.ok(declaration, `Missing implementation: ${name}`);
      vm.runInContext(dispatchSource.slice(...declaration.range), context);
    }
    await context.initDispatch();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["render", "snapshot", "render", "connected"]);
    assert.equal(context.mbtBinDispatchEnabled, false);
    if (!enabled) {
      assert.equal(await context.loadMbtBinFrontLegs(), false);
      assert.equal(events.includes("feed"), false, "A disabled BIN gate cannot request the feed, even directly.");
    }
  }
});
