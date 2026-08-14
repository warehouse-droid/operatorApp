import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const publicUrl = new URL("../../../public/", import.meta.url);
const clientUrl = new URL("dispatch-scm.js", publicUrl);
const client = fs.readFileSync(clientUrl, "utf8");
const page = fs.readFileSync(new URL("dispatch-scm.html", publicUrl), "utf8");

function clientContext(controls = new Map()) {
  const scmApp = {
    addEventListener() {},
    contains() { return false; },
    querySelector(selector) {
      const matched = controls.get(selector);
      return Array.isArray(matched) ? matched[0] || null : matched || null;
    },
    querySelectorAll(selector) {
      const matched = controls.get(selector);
      if (Array.isArray(matched)) {
        return matched;
      }
      return matched ? [matched] : [];
    }
  };
  const context = vm.createContext({
    CSS: { escape: (value) => String(value) },
    URLSearchParams,
    clearTimeout,
    confirm: () => true,
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

test("split PO details do not render an Update action", () => {
  const context = clientContext();
  const html = vm.runInContext(`
    scmDestinationLocationId = "15";
    scmPickupPoint = "PERMACON Bolton";
    scmRenameRef = "3022124135";
    renderScmScheduleMiniPanel({
      id: "3022124135",
      type: "PO",
      isScmSplit: true,
      destinationLocationId: 15,
      vendorYardOptions: [
        { yard: "PERMACON Bolton", vendor: "PERMACON" },
        { yard: "PERMACON Milton", vendor: "PERMACON" }
      ],
      scm: { pickupPoint: "PERMACON Bolton", status: "Queued", method: "MBT" }
    });
  `, context);

  assert.doesNotMatch(html, /<button[^>]+data-action="update-split"/i);
  assert.match(html, /<button[^>]+data-action="unsplit-order"/i,
    "removing Update must not remove the Unsplit recovery action");
  assert.match(html, /data-action="save-scm-schedule"/,
    "removing Update must not remove schedule persistence");

  const sourceHtml = vm.runInContext(`
    scmDestinationLocationId = "15";
    scmPickupPoint = "PERMACON Bolton";
    renderScmScheduleMiniPanel({
      id: "POB03535",
      type: "PO",
      isScmSplit: false,
      destinationLocationId: 15,
      vendorYardOptions: [{ yard: "PERMACON Bolton", vendor: "PERMACON" }],
      scm: { pickupPoint: "PERMACON Bolton", status: "Queued", method: "MBT" }
    });
  `, context);
  assert.doesNotMatch(sourceHtml, /data-action="unsplit-order"/,
    "the split-only recovery action must not leak onto a source PO");
});

test("the PO-split page requests the fixed client with a new cache key", () => {
  assert.match(page, /dispatch-scm\.js\?v=20260813-po-split-status-v3/);
});

test("Create PO Ref submits the live modal yard selections instead of stale state", async () => {
  const controls = new Map([
    ['[data-action="split-destination-yard"]', { value: "28" }],
    ['[data-action="split-pickup-yard"]', { value: "PERMACON Milton" }]
  ]);
  const context = clientContext(controls);
  vm.runInContext(`
    scmOrders = [{
      id: "POB03535",
      originalPoRef: "POB03535",
      destinationLocationId: 15,
      vendorYardOptions: [
        { yard: "PERMACON Bolton", vendor: "PERMACON" },
        { yard: "PERMACON Milton", vendor: "PERMACON" }
      ],
      items: [{
        lineRowId: 44,
        itemName: "Production-history line",
        pallets: 5,
        quantity: 5,
        toPlt: 1
      }]
    }];
    selectedScmOrderId = "POB03535";
    scmRef = "3022124135";
    scmLineInputs = { "44": { pallets: 1, layers: 0, sections: 0, pieces: 0, salesQty: 0 } };

    // Reproduce the report: state still contains the first/default yards while
    // the operator has already chosen different values in the live modal.
    scmDestinationLocationId = "15";
    scmPickupPoint = "PERMACON Bolton";

    renderScm = () => {};
    loadScmOrders = async () => {};
    scmApi = async (path, options) => {
      globalThis.__capturedRequest = { path, options };
      return { created: { split: { splitPoRef: "3022124135" } } };
    };
  `, context);

  await vm.runInContext("createScmSplit()", context);
  const request = context.__capturedRequest;
  assert.equal(request.path, "/api/dispatch/scm/purchase-order-splits");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.destinationLocationId, "28", "the live 2967 destination must be submitted");
  assert.equal(payload.pickupPoint, "PERMACON Milton", "the live pickup-yard selection must be submitted");
});

async function captureCreatePayload({
  liveDestination,
  livePickup,
  stateDestination = "15",
  statePickup = "PERMACON Bolton",
  vendorYards = [
    { yard: "PERMACON Bolton", vendor: "PERMACON" },
    { yard: "PERMACON Milton", vendor: "PERMACON" }
  ]
} = {}) {
  const controls = new Map();
  if (liveDestination !== undefined) {
    controls.set('[data-action="split-destination-yard"]', { value: liveDestination });
  }
  if (livePickup !== undefined) {
    controls.set('[data-action="split-pickup-yard"]', { value: livePickup });
  }
  const context = clientContext(controls);
  vm.runInContext(`
    scmOrders = [{
      id: "PROPERTY-SOURCE",
      originalPoRef: "PROPERTY-SOURCE",
      destinationLocationId: 15,
      vendorYardOptions: ${JSON.stringify(vendorYards)},
      items: [{ lineRowId: 91, itemName: "Property line", pallets: 10, quantity: 10, toPlt: 1 }]
    }];
    selectedScmOrderId = "PROPERTY-SOURCE";
    scmRef = "PROPERTY-SPLIT";
    scmLineInputs = { "91": { pallets: 1, layers: 0, sections: 0, pieces: 0, salesQty: 0 } };
    scmDestinationLocationId = ${JSON.stringify(stateDestination)};
    scmPickupPoint = ${JSON.stringify(statePickup)};
    renderScm = () => {};
    loadScmOrders = async () => {};
    scmApi = async (_path, options) => {
      globalThis.__capturedRequest = { options };
      return { created: { split: { splitPoRef: "PROPERTY-SPLIT" } } };
    };
  `, context);
  await vm.runInContext("createScmSplit()", context);
  return JSON.parse(context.__capturedRequest.options.body);
}

test("all supported create-yard combinations round-trip from the live modal", async () => {
  const destinations = ["1", "15", "28", "26"];
  const pickups = ["PERMACON Bolton", "PERMACON Milton"];
  for (const destinationLocationId of destinations) {
    for (const pickupPoint of pickups) {
      const payload = await captureCreatePayload({
        liveDestination: destinationLocationId,
        livePickup: pickupPoint,
        stateDestination: destinationLocationId === "15" ? "28" : "15",
        statePickup: pickupPoint === "PERMACON Bolton" ? "PERMACON Milton" : "PERMACON Bolton"
      });
      assert.equal(payload.destinationLocationId, destinationLocationId);
      assert.equal(payload.pickupPoint, pickupPoint);
    }
  }
});

test("missing or invalid live controls cannot replace valid retained yard state", async () => {
  const missing = await captureCreatePayload({
    stateDestination: "28",
    statePickup: "PERMACON Milton"
  });
  assert.equal(missing.destinationLocationId, "28");
  assert.equal(missing.pickupPoint, "PERMACON Milton");

  const invalid = await captureCreatePayload({
    liveDestination: "999",
    livePickup: "Unknown Yard",
    stateDestination: "26",
    statePickup: "PERMACON Bolton"
  });
  assert.equal(invalid.destinationLocationId, "26");
  assert.equal(invalid.pickupPoint, "PERMACON Bolton");
});

test("a source without mapped vendor yards cannot submit a stray pickup value", async () => {
  const payload = await captureCreatePayload({
    liveDestination: "1",
    livePickup: "Unknown Yard",
    statePickup: "Legacy Unmapped Yard",
    vendorYards: []
  });
  assert.equal(payload.destinationLocationId, "1");
  assert.equal(payload.pickupPoint, "");
});

test("split Schedule Save submits the live status revision and retains a failed draft", async () => {
  const status = {
    dataset: { scmField: "status" },
    type: "select-one",
    value: "Priority"
  };
  const controls = new Map([["[data-scm-field]", [status]]]);
  const context = clientContext(controls);
  vm.runInContext(`
    scmOrders = [{
      id: "STATUS-SPLIT",
      originalPoRef: "STATUS-SPLIT",
      type: "PO",
      isScmSplit: true,
      items: [],
      scm: {
        status: "Queued",
        method: "MBT",
        updatedAt: "2026-08-13T20:00:00.123Z"
      }
    }];
    selectedScmOrderId = "STATUS-SPLIT";
    renderScm = () => {};
    loadScmOrders = async () => { throw new Error("A failed save must not reload over the draft."); };
    scmApi = async (path, options) => {
      globalThis.__capturedRequest = { path, options };
      throw new Error("simulated network failure");
    };
  `, context);

  await vm.runInContext("saveScmScheduleForSelected()", context);
  const request = context.__capturedRequest;
  assert.equal(request.path, "/api/scm/schedule/STATUS-SPLIT");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.status, "Priority", "the status visible when Save is clicked must be submitted");
  assert.equal(payload.expectedUpdatedAt, "2026-08-13T20:00:00.123Z",
    "the split detail must protect its loaded schedule revision");
  assert.equal(vm.runInContext("scmOrders[0].scm.status", context), "Priority",
    "a failed request must keep the selected status visible for an intentional retry");
  assert.match(vm.runInContext("scmNotice", context), /Save schedule failed: simulated network failure/);
});
