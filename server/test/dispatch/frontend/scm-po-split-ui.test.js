import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const publicUrl = new URL("../../../public/", import.meta.url);
const clientUrl = new URL("dispatch-scm.js", publicUrl);
const client = fs.readFileSync(clientUrl, "utf8");
const page = fs.readFileSync(new URL("dispatch-scm.html", publicUrl), "utf8");
const styles = fs.readFileSync(new URL("dispatch.css", publicUrl), "utf8");

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
  assert.match(sourceHtml, /data-scm-field="dropoffPoint"/,
    "PO Split must expose the same durable destination override as PO\/TO Schedule");
  assert.match(sourceHtml, /Override all PO lines/,
    "the destination control must explain that it replaces mixed NetSuite line routing");
  assert.match(sourceHtml, /12441 \(NetSuite\)/,
    "the retained NetSuite destination must be labelled directly and concisely");
  assert.match(sourceHtml, /scm-mini-row scm-mini-routing-row/,
    "schedule controls should occupy a dedicated first row");
  assert.match(sourceHtml, /scm-mini-row scm-mini-notes-row/,
    "destination, remark, and actions should occupy a balanced second row");
});

test("the PO-split page requests the fixed client with a new cache key", () => {
  assert.match(page, /dispatch-scm\.js\?v=20260831-live-schedule-v1/);
  assert.match(page, /dispatch\.css\?v=20260831-live-schedule-v1/);
});

test("the PO Split schedule panel uses a responsive two-row layout", () => {
  assert.match(styles, /\.scm-mini-routing-row\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /\.scm-mini-notes-row\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*\.scm-mini-notes-row\s*\{[^}]*minmax\(0, 1fr\)/);
});

test("PO Split renders canonical completion instead of retaining a Planned badge", () => {
  const context = clientContext();
  const html = vm.runInContext(`
    scmLoading = false;
    selectedScmOrderId = "SPLIT-COMPLETE-L1";
    scmOrders = [{
      id: "SPLIT-COMPLETE-L1",
      type: "PO",
      isScmSplit: true,
      sourcePoRef: "SPLIT-COMPLETE",
      customer: "Completion Vendor",
      destinationYard: "3445",
      dispatchPlanDate: "2026-08-25",
      dispatchTruckPlate: "CE94489",
      dispatchLoadName: "Load 1",
      scm: { status: "Completed", etaDate: "2026-08-25" },
      items: [{ pallets: 22, toPlt: 9, quantity: 198 }]
    }];
    renderOrderList();
  `, context);

  assert.match(html, /scm-completed-badge[^>]*>Completed</);
  assert.doesNotMatch(html, /scm-planned-badge[^>]*>Planned</);
});

test("split quantity editor submits complete desired state with its optimistic revision", async () => {
  const context = clientContext();
  vm.runInContext(`
    scmOrders = [{ id: "SPLIT-EDIT-L1", type: "PO", isScmSplit: true, scmSplitRevision: 7 }];
    selectedScmOrderId = "SPLIT-EDIT-L1";
    scmSplitEditor = {
      split: {
        splitPoRef: "SPLIT-EDIT-L1",
        sourcePoRef: "SPLIT-EDIT",
        revision: 7,
        locked: false
      },
      lines: [
        {
          sourceLineId: 101,
          sku: "CURRENT-SKU",
          inSplit: true,
          canAdd: false,
          toPlt: 10,
          toLyr: 0,
          toSec: 0,
          toPcs: 1,
          current: { pallets: 5, layers: 0, sections: 0, pieces: 0, salesQty: 50 },
          maximum: { pallets: 12, layers: 0, sections: 0, pieces: 120, salesQty: 120 }
        },
        {
          sourceLineId: 202,
          sku: "SOURCE-ONLY-SKU",
          inSplit: false,
          canAdd: true,
          toPlt: 10,
          toLyr: 0,
          toSec: 0,
          toPcs: 1,
          current: { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0 },
          maximum: { pallets: 8, layers: 0, sections: 0, pieces: 80, salesQty: 80 }
        }
      ]
    };
    scmSplitLineInputs = {
      "101": { pallets: 0, layers: 0, sections: 0, pieces: 0, salesQty: 0 },
      "202": { pallets: 2, layers: 0, sections: 0, pieces: 0, salesQty: 0 }
    };
    renderScm = () => {};
    loadScmOrders = async () => {};
    scmApi = async (path, options) => {
      globalThis.__capturedRequest = { path, options };
      return { updated: { changes: [{ sourceLineId: 101 }, { sourceLineId: 202 }] } };
    };
  `, context);

  await vm.runInContext("saveScmSplitLines()", context);
  const request = context.__capturedRequest;
  assert.equal(request.path, "/api/dispatch/scm/purchase-order-splits/SPLIT-EDIT-L1/lines");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.expectedRevision, 7);
  assert.deepEqual(payload.lines.map((line) => ({
    sourceLineId: line.sourceLineId,
    pallets: line.pallets,
    salesQty: line.salesQty
  })), [
    { sourceLineId: 101, pallets: 0, salesQty: 0 },
    { sourceLineId: 202, pallets: 2, salesQty: 0 }
  ], "an existing line cleared to zero must remain in the complete desired state");
});

test("converted split lines never retain a hidden sales quantity after their visible units are cleared", () => {
  const context = clientContext();
  const input = vm.runInContext(`scmSplitInputForLine({
    sourceLineId: 301,
    toPlt: 10,
    current: { pallets: 4, layers: 0, sections: 0, pieces: 0, salesQty: 40 }
  })`, context);
  assert.equal(input.pallets, 4);
  assert.equal(input.salesQty, 0,
    "the hidden derived quantity must not prevent Remove from submitting a true zero");
});

test("an operational split renders an unplan-first lock instead of editable quantity actions", () => {
  const context = clientContext();
  const html = vm.runInContext(`
    scmSplitEditor = {
      split: { splitPoRef: "LOCKED-L1", sourcePoRef: "LOCKED", revision: 3, locked: true },
      lines: [{
        sourceLineId: 401,
        sku: "LOCKED-SKU",
        inSplit: true,
        canAdd: false,
        toPlt: 10,
        current: { pallets: 1, salesQty: 10 },
        maximum: { pallets: 5, salesQty: 50 }
      }]
    };
    renderScmSplitLineEditor({ id: "LOCKED-L1", isScmSplit: true, scmSplitLocked: true });
  `, context);
  assert.match(html, /Unplan\/unlink it before changing any split detail/);
  assert.match(html, /data-action="save-split-lines"[^>]+disabled/);
  assert.match(html, /data-action="split-line-qty"[^>]+disabled/);
});

test("Create PO Ref submits the live modal yard selections instead of stale state", async () => {
  const controls = new Map([
    ['[data-action="split-destination-yard"]', { value: "28" }],
    ['[data-action="split-pickup-yard"]', { value: "PERMACON Milton" }],
    ['[data-action="split-initial-status"]', { value: "Priority" }],
    ['[data-action="split-remark"]', { value: "Deliver before the long weekend." }]
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
  assert.equal(payload.status, "Priority", "the live initial status must be submitted");
  assert.equal(payload.remarkOverride, "Deliver before the long weekend.",
    "the live creation remark must be submitted");
});

test("Create PO Ref renders only manual status choices and a bounded remark", () => {
  const context = clientContext();
  const html = vm.runInContext(`
    scmSummaryOpen = true;
    selectedScmOrderId = "POB-CREATE-METADATA";
    scmOrders = [{
      id: "POB-CREATE-METADATA",
      destinationLocationId: 15,
      items: [{ lineRowId: 711, itemName: "Line", pallets: 2, quantity: 20, toPlt: 10 }]
    }];
    scmLineInputs = { "711": { pallets: 1, layers: 0, sections: 0, pieces: 0, salesQty: 0 } };
    scmSplitInitialStatus = "Hold";
    scmSplitRemark = "Handle & verify <labels>";
    renderScmSplitModal();
  `, context);

  assert.match(html, /data-action="split-initial-status"/);
  for (const status of ["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"]) {
    assert.match(html, new RegExp(`<option value="${status}"`));
  }
  for (const controlled of ["Planned", "Partially Done", "In Transit", "Completed", "Reconcile Review"]) {
    assert.doesNotMatch(html, new RegExp(`<option value="${controlled}"`));
  }
  assert.match(html, /<option value="Hold" selected>/);
  assert.match(html, /data-action="split-remark"[^>]+maxlength="2000"/);
  assert.match(html, /Handle &amp; verify &lt;labels&gt;/);
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
  assert.equal(request.path, "/api/scm/schedule/STATUS-SPLIT?includeSchedule=false");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.status, "Priority", "the status visible when Save is clicked must be submitted");
  assert.equal(payload.expectedUpdatedAt, "2026-08-13T20:00:00.123Z",
    "the split detail must protect its loaded schedule revision");
  assert.equal(vm.runInContext("scmOrders[0].scm.status", context), "Priority",
    "a failed request must keep the selected status visible for an intentional retry");
  assert.match(vm.runInContext("scmNotice", context), /Save schedule failed: simulated network failure/);
});

test("PO Split Save prefers a newer hydrated schedule over its stale catalog card", async () => {
  const context = clientContext();
  vm.runInContext(`
    scmOrders = [{
      id: "3022130415",
      type: "PO",
      items: [],
      scm: {
        status: "Queued",
        method: "MBT",
        pickupPoint: "Stale catalog yard",
        updatedAt: "2026-08-31T02:29:06.620731Z"
      }
    }];
    scmOrderDetail = {
      id: "3022130415",
      type: "PO",
      items: [],
      scm: {
        status: "Planned",
        method: "Vendor",
        pickupPoint: "Live schedule yard",
        updatedAt: "2026-08-31T02:29:33.265579Z"
      }
    };
    selectedScmOrderId = "3022130415";
    renderScm = () => {};
    globalThis.__selectedBeforeSave = scmSelectedOrder();
    scmApi = async (path, options) => {
      globalThis.__capturedRequest = { path, options };
      return { row: {
        orderKind: "PO",
        orderRef: "3022130415",
        status: "Planned",
        method: "Vendor",
        pickupPoint: "Live schedule yard",
        updatedAt: "2026-08-31T02:29:34.000001Z"
      } };
    };
  `, context);

  assert.equal(context.__selectedBeforeSave.scm.status, "Planned",
    "the hydrated live status must not be replaced by an older list card");
  assert.equal(context.__selectedBeforeSave.scm.pickupPoint, "Live schedule yard");
  await vm.runInContext("saveScmScheduleForSelected()", context);
  const payload = JSON.parse(context.__capturedRequest.options.body);
  assert.equal(payload.expectedUpdatedAt, "2026-08-31T02:29:33.265579Z",
    "Save must protect the newest live schedule revision loaded for the selected PO");
});

test("PO Split compares exact microsecond schedule revisions in both merge directions", () => {
  const context = clientContext();
  vm.runInContext(`
    scmOrders = [{
      id: "MICROSECOND-PO",
      scm: { status: "Queued", marker: "card-old", updatedAt: "2026-08-31T02:29:33.265100Z" }
    }];
    scmOrderDetail = {
      id: "MICROSECOND-PO",
      scm: { status: "Planned", marker: "detail-new", updatedAt: "2026-08-31T02:29:33.265579Z" }
    };
    selectedScmOrderId = "MICROSECOND-PO";
  `, context);
  assert.equal(vm.runInContext("scmSelectedOrder().scm.marker", context), "detail-new",
    "detail must win when it is newer inside the same millisecond");

  vm.runInContext(`
    scmOrders[0].scm = {
      status: "Hold",
      marker: "card-new",
      updatedAt: "2026-08-31T02:29:33.265900Z"
    };
  `, context);
  assert.equal(vm.runInContext("scmSelectedOrder().scm.marker", context), "card-new",
    "a later targeted card refresh must win over older hydrated detail");
});

test("property matrix: PO Split always selects the greatest exact schedule revision", () => {
  const context = clientContext();
  for (let index = 0; index < 128; index += 1) {
    const cardMicros = (index * 7919) % 1000;
    let detailMicros = (index * 3571 + 17) % 1000;
    if (detailMicros === cardMicros) {
      detailMicros = (detailMicros + 1) % 1000;
    }
    const cardRevision = `2026-08-31T02:29:33.265${String(cardMicros).padStart(3, "0")}Z`;
    const detailRevision = `2026-08-31T02:29:33.265${String(detailMicros).padStart(3, "0")}Z`;
    vm.runInContext(`
      scmOrders = [{ id: "PROPERTY-REVISION", scm: {
        marker: "card", updatedAt: ${JSON.stringify(cardRevision)}
      } }];
      scmOrderDetail = { id: "PROPERTY-REVISION", scm: {
        marker: "detail", updatedAt: ${JSON.stringify(detailRevision)}
      } };
      selectedScmOrderId = "PROPERTY-REVISION";
    `, context);
    assert.equal(
      vm.runInContext("scmSelectedOrder().scm.marker", context),
      detailMicros > cardMicros ? "detail" : "card",
      `${cardRevision} versus ${detailRevision}`
    );
  }
});

test("adversarial schedule revision values fail toward the valid or hydrated state", () => {
  const context = clientContext();
  const select = (cardRevision, detailRevision) => vm.runInContext(`
    scmOrders = [{ id: "ADVERSARIAL-REVISION", scm: {
      marker: "card", updatedAt: ${JSON.stringify(cardRevision)}
    } }];
    scmOrderDetail = { id: "ADVERSARIAL-REVISION", scm: {
      marker: "detail", updatedAt: ${JSON.stringify(detailRevision)}
    } };
    selectedScmOrderId = "ADVERSARIAL-REVISION";
    scmSelectedOrder().scm.marker;
  `, context);

  assert.equal(select("2026-08-31T02:29:33.265579Z", "not-a-timestamp"), "card");
  assert.equal(select("<script>alert(1)</script>", "2026-08-31T02:29:33.265579Z"), "detail");
  assert.equal(select("", ""), "detail", "the later hydrated response wins when neither row exists yet");
  assert.equal(
    select("2026-08-31T02:29:33.265579Z", "2026-08-31T02:29:33.265579Z"),
    "detail",
    "equal revisions prefer the complete hydrated detail"
  );
});

test("split Schedule Save changes the physical split destination before saving the shared schedule", async () => {
  const destination = {
    dataset: { scmField: "dropoffPoint" },
    type: "select-one",
    value: "12441"
  };
  const controls = new Map([["[data-scm-field]", [destination]]]);
  const context = clientContext(controls);
  vm.runInContext(`
    scmOrders = [{
      id: "DESTINATION-SPLIT",
      originalPoRef: "DESTINATION-SPLIT",
      type: "PO",
      isScmSplit: true,
      destinationYard: "3445",
      items: [],
      scm: {
        status: "Queued",
        method: "MBT",
        dropoffPoint: "3445",
        updatedAt: "2026-08-24T12:00:00.123Z"
      }
    }];
    selectedScmOrderId = "DESTINATION-SPLIT";
    renderScm = () => {};
    loadScmOrders = async () => {};
    globalThis.__requests = [];
    scmApi = async (path, options) => {
      globalThis.__requests.push({ path, options });
      if (path.endsWith("/destination")) {
        return { updated: { destinationLocation: "12441", scheduleUpdatedAt: "2026-08-24T12:01:00.456789Z" } };
      }
      return { updated: {} };
    };
  `, context);

  await vm.runInContext("saveScmScheduleForSelected()", context);
  const requests = context.__requests;
  assert.deepEqual(Array.from(requests, (request) => String(request.path)), [
    "/api/dispatch/scm/purchase-order-splits/DESTINATION-SPLIT/destination",
    "/api/scm/schedule/DESTINATION-SPLIT?includeSchedule=false"
  ]);
  const destinationPatch = JSON.parse(requests[0].options.body);
  assert.equal(destinationPatch.destinationLocationId, "15");
  assert.equal(destinationPatch.expectedUpdatedAt, "2026-08-24T12:00:00.123Z");
  const schedulePatch = JSON.parse(requests[1].options.body);
  assert.equal(schedulePatch.dropoffPoint, "12441");
  assert.equal(schedulePatch.expectedUpdatedAt, "2026-08-24T12:01:00.456789Z",
    "the second save must use the schedule revision created by the destination transaction");
  assert.equal(vm.runInContext("scmOrders[0].destinationYard", context), "12441",
    "the saved physical destination must immediately become the local NetSuite baseline");
});

test("successful Schedule Save applies its authoritative row without a stale catalog reload", async () => {
  const status = {
    dataset: { scmField: "status" },
    type: "select-one",
    value: "Hold"
  };
  const remark = {
    dataset: { scmField: "remarkOverride" },
    type: "textarea",
    value: "Hold for revised appointment"
  };
  const controls = new Map([["[data-scm-field]", [status, remark]]]);
  const context = clientContext(controls);
  vm.runInContext(`
    scmOrders = [{
      id: "SCHEDULE-FRESH-L1",
      type: "PO",
      isScmSplit: true,
      items: [],
      scm: { status: "Queued", remarkOverride: "Old remark", updatedAt: "2026-08-29T10:00:00.000Z" }
    }];
    selectedScmOrderId = "SCHEDULE-FRESH-L1";
    renderScm = () => {};
    globalThis.__reloads = 0;
    loadScmOrders = async () => {
      globalThis.__reloads += 1;
      scmOrders[0].scm.status = "Queued";
      scmOrders[0].scm.remarkOverride = "Old remark";
    };
    scmApi = async (path) => {
      globalThis.__savedPath = path;
      return { row: {
        orderKind: "PO",
        orderRef: "SCHEDULE-FRESH-L1",
        method: "MBT",
        status: "Hold",
        remarkOverride: "Hold for revised appointment",
        scheduleDropoffPoint: "",
        pickupPoint: "Vendor yard",
        updatedAt: "2026-08-29T10:01:00.123456Z"
      } };
    };
  `, context);

  await vm.runInContext("saveScmScheduleForSelected()", context);
  assert.equal(context.__savedPath, "/api/scm/schedule/SCHEDULE-FRESH-L1?includeSchedule=false");
  assert.equal(context.__reloads, 0,
    "the authoritative mutation response must not be replaced by an eventually refreshed list");
  assert.equal(vm.runInContext("scmOrders[0].scm.status", context), "Hold");
  assert.equal(vm.runInContext("scmOrders[0].scm.remarkOverride", context), "Hold for revised appointment");
  assert.equal(vm.runInContext("scmOrders[0].scm.updatedAt", context), "2026-08-29T10:01:00.123456Z");
});

test("locked split remark save keeps the authoritative remark visible", async () => {
  const remark = { value: "Driver confirmed revised dock" };
  const controls = new Map([['[data-scm-field="remarkOverride"]', remark]]);
  const context = clientContext(controls);
  vm.runInContext(`
    scmOrders = [{
      id: "REMARK-FRESH-L1",
      type: "PO",
      isScmSplit: true,
      items: [],
      scm: { status: "Planned", remarkOverride: "Old remark", updatedAt: "2026-08-29T11:00:00.000Z" }
    }];
    selectedScmOrderId = "REMARK-FRESH-L1";
    renderScm = () => {};
    globalThis.__reloads = 0;
    loadScmOrders = async () => { globalThis.__reloads += 1; };
    scmApi = async () => ({ row: {
      orderKind: "PO",
      orderRef: "REMARK-FRESH-L1",
      method: "MBT",
      status: "Planned",
      remarkOverride: "Driver confirmed revised dock",
      scheduleDropoffPoint: "",
      updatedAt: "2026-08-29T11:01:00.654321Z"
    } });
  `, context);

  await vm.runInContext("saveScmRemarkForSelected()", context);
  assert.equal(context.__reloads, 0);
  assert.equal(vm.runInContext("scmOrders[0].scm.remarkOverride", context), "Driver confirmed revised dock");
  assert.equal(vm.runInContext("scmOrders[0].scm.updatedAt", context), "2026-08-29T11:01:00.654321Z");
});
