import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const clientUrl = new URL("../../../public/dispatch-scm.js", import.meta.url);
const client = fs.readFileSync(clientUrl, "utf8");
const scheduleClient = fs.readFileSync(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");

function clientContext() {
  const scmApp = {
    addEventListener() {},
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    CSS: { escape: (value) => String(value) },
    URLSearchParams,
    clearTimeout,
    console,
    document: {
      activeElement: null,
      getElementById: () => scmApp
    },
    fetch: async () => { throw new Error("Unexpected network call"); },
    requireDispatchLogin() {},
    sessionStorage: { getItem: () => "" },
    setTimeout,
    window: {
      MBBS_I18N: null,
      addEventListener() {},
      location: { search: "" },
      scrollX: 0,
      scrollY: 0
    }
  });
  vm.runInContext(client, context, { filename: fileURLToPath(clientUrl) });
  return context;
}

test("manual split creation defaults to Hold in the confirmation modal", () => {
  const context = clientContext();
  assert.equal(vm.runInContext("scmSplitInitialStatus", context), "Hold");
});

test("legacy manual split routing is labelled as split-confirmed rather than NetSuite-derived", () => {
  const context = clientContext();
  const splitHtml = vm.runInContext(`renderScmScheduleMiniPanel({
    id: "SN-MANUAL-LOCATION",
    type: "PO",
    isScmSplit: true,
    destinationYard: "12441",
    destinationLocationId: "15",
    scm: { status: "Hold", dropoffPoint: "", method: "MBT" }
  })`, context);
  assert.match(splitHtml, /12441 \(Split confirmation\)/);
  assert.doesNotMatch(splitHtml, /12441 \(NetSuite\)/);

  const sourceHtml = vm.runInContext(`renderScmScheduleMiniPanel({
    id: "PO-MANUAL-LOCATION-SOURCE",
    type: "PO",
    isScmSplit: false,
    destinationYard: "3445",
    destinationLocationId: "1",
    scm: { status: "Hold", dropoffPoint: "", method: "MBT" }
  })`, context);
  assert.match(sourceHtml, /3445 \(NetSuite\)/);
});

test("PO/TO Schedule labels a split child's selected destination as user-confirmed", () => {
  const start = scheduleClient.indexOf("function poDestinationOverrideSelectHtml");
  const end = scheduleClient.indexOf("\nfunction inputHtml", start);
  assert.ok(start >= 0 && end > start, "The destination renderer must remain directly testable.");
  const context = vm.createContext({
    scmScheduleEscape: (value) => String(value)
  });
  vm.runInContext(scheduleClient.slice(start, end), context);

  const splitHtml = vm.runInContext(`poDestinationOverrideSelectHtml({
    rowId: "PO::SN-MANUAL-LOCATION",
    row: {
      isScmSplit: true,
      scheduleDropoffPoint: "12441",
      dropoffPoint: "12441"
    },
    options: ["3445", "12441"],
    disabled: true
  })`, context);
  assert.match(
    splitHtml,
    /<option value="12441" selected>12441 \(Split confirmation\)<\/option>/,
    "the selected split destination—not only an unused fallback option—must carry its source"
  );
  assert.doesNotMatch(splitHtml, /NetSuite/);

  const sourceHtml = vm.runInContext(`poDestinationOverrideSelectHtml({
    rowId: "PO::PO-MANUAL-LOCATION-SOURCE",
    row: {
      isScmSplit: false,
      scheduleDropoffPoint: "",
      dropoffPoint: "3445"
    },
    options: ["3445", "12441"],
    disabled: false
  })`, context);
  assert.match(sourceHtml, /3445 \(NetSuite\)/);
});

test("both PO catalog response paths carry manual split identity into status projection", () => {
  assert.equal(
    [...server.matchAll(/isScmSplit: order\.isScmSplit === true/g)].length,
    2
  );
});
