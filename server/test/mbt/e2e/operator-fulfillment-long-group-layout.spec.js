import { readFile } from "node:fs/promises";

import { expect, test } from "./mbt-e2e-test.js";

/* global document, HTMLMediaElement, MediaStream, getComputedStyle, localStorage, navigator, window */

test.use({ serviceWorkers: "block" });

const GROUP_ID = "GOA-7308-7309-7311";
const GROUP_REF = "SOA07308+SOA07309+SOA07311";
const packedItems = [
  ["Alliance Supersand Grey", 0, 10],
  ["UNI-PISAS-COP-SAFARI", 0, 28],
  ["UNI-PISAS-JUM/COR-2106-SAFARI", 1, 7],
  ["UNI-SIES-COP383-CEL-GN", 0, 7],
  ["UNI-SIES-COP383-CER-GN", 0, 7],
  ["UNI-SIES-COP383-GN", 0, 6],
  ["UNI-SIES-COR375-GN", 1, 2],
  ["UNI-SIES-STD375-GN", 1, 5],
  ["UNI-WIN70S-RDM-SAFARI", 3, 0]
];

const groupedOrder = Object.freeze({
  netsuite_id: GROUP_ID,
  dispatch_group_id: GROUP_ID,
  tranid: GROUP_REF,
  order_type: "sales_order",
  customer: "Long grouped-order layout regression",
  outbound_location_id: 15,
  outbound_location: "12441",
  operator_status: "packed",
  local_yard_order_status: "Open",
  dispatch_planned: true,
  dispatch_plan_date: "2026-08-25",
  dispatch_truck_plate: "BC71838",
  dispatch_load_name: "Load 2",
  child_order_ids: ["959873", "959890", "959901"],
  child_orders: [
    { netsuite_id: "959873", tranid: "SOA07308" },
    { netsuite_id: "959890", tranid: "SOA07309" },
    { netsuite_id: "959901", tranid: "SOA07311" }
  ],
  lines: packedItems.map(([sku, pallets, pieces], index) => ({
    id: `GRPLINE-LAYOUT-${index + 1}`,
    line_id: String(4_814_502 + index),
    item_id: String(8_100 + index),
    item_name: sku,
    sku,
    item_type: "InvtPart",
    quantity: Math.max(1, pallets + pieces),
    unit: "EA",
    pallet_qty: pallets,
    layer_qty: 0,
    section_qty: 0,
    piece_qty: pieces,
    packed_pallet_qty: pallets,
    packed_layer_qty: 0,
    packed_section_qty: 0,
    packed_piece_qty: pieces,
    packed_sales_qty: Math.max(1, pallets + pieces),
    loaded_qty: 0,
    netsuite_active: true,
    confirmed: true
  }))
});

const operatorCss = await readFile(new URL("../../../public/operator.css", import.meta.url), "utf8");
const operatorJs = await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8");

function fulfillJson(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function installAssets(page) {
  await page.route("**/operator.css*", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: operatorCss
  }));
  await page.route("**/operator.js*", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: operatorJs
  }));
}

async function installSessionAndCamera(page) {
  await page.addInitScript(({ groupId }) => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    const track = {
      stop() {},
      getSettings() { return { deviceId: "layout-camera" }; },
      getCapabilities() { return {}; },
      async applyConstraints() {}
    };
    const stream = new MediaStream();
    stream.getTracks = () => [track];
    stream.getVideoTracks = () => [track];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async enumerateDevices() {
          return [{ kind: "videoinput", deviceId: "layout-camera", label: "Back Camera" }];
        },
        async getUserMedia() { return stream; }
      }
    });
    HTMLMediaElement.prototype.play = async () => {};
    localStorage.setItem("mbbs.staff.token", "long-group-layout-token");
    localStorage.setItem("mbbs.operator.token", "long-group-layout-token");
    localStorage.setItem("mbbs.operator.locationId", "15");
    localStorage.setItem("mbbs.operator.deliveryPrepMode", "load");
    localStorage.setItem("mbbs.operator.deliveryLoadViewDate", "2026-08-25");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({
      currentModule: "delivery",
      locationId: 15,
      viewMode: "packed",
      deliveryOrderType: "sales_order",
      deliveryPrepMode: "load",
      deliveryLoadViewDate: "2026-08-25",
      selectedId: groupId,
      selectedLineId: "GRPLINE-LAYOUT-1"
    }));
  }, { groupId: GROUP_ID });
}

async function installApi(page) {
  const unexpected = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {
      return fulfillJson(route, {
        operator: {
          id: "layout-operator",
          username: "layout-operator",
          display_name: "Layout Operator",
          role: "operator",
          roles: ["operator"]
        }
      });
    }
    if (pathname === "/api/delivery/notifications") {
      return fulfillJson(route, { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] });
    }
    if (pathname === "/api/delivery/current-draft") {
      return fulfillJson(route, null);
    }
    if (pathname === "/api/delivery/saved-order-keys" || pathname === "/api/operator/requests") {
      return fulfillJson(route, []);
    }
    if (pathname === "/api/delivery/load-trucks") {
      return fulfillJson(route, [{ truck_plate: "BC71838", load_count: 1, order_count: 1, first_load_name: "Load 2" }]);
    }
    if (pathname === "/api/delivery/load-orders") {
      return fulfillJson(route, [groupedOrder]);
    }
    if (pathname === `/api/delivery/orders/${GROUP_ID}`) {
      return fulfillJson(route, groupedOrder);
    }
    if (pathname === "/api/operator/netsuite-posting-policy") {
      return fulfillJson(route, {
        schemaVersion: "operator-netsuite-posting-policy-v1",
        supported: true,
        gateKey: "operator_netsuite_delivery_prep_if_12441",
        functionKey: "delivery_prep",
        transactionType: "IF",
        locationId: 15,
        yardCode: "12441",
        present: true,
        configured: false,
        environmentAllowed: false,
        effective: false,
        revision: 1
      });
    }
    unexpected.push(`${request.method()} ${pathname}`);
    return fulfillJson(route, { error: `Unhandled layout fixture ${request.method()} ${pathname}` }, 404);
  });
  return unexpected;
}

async function openLongGroupLoad(page, viewport) {
  await page.setViewportSize(viewport);
  await installAssets(page);
  await installSessionAndCamera(page);
  const unexpected = await installApi(page);
  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: GROUP_REF, exact: true })).toBeVisible();
  await page.locator('[data-action="start-fulfill"]').click();
  await expect(page.getByText("Packed qty to load", { exact: true })).toBeVisible();
  return unexpected;
}

test("long grouped load keeps its packed-line list scrollable and outside the photo workspace", async ({ page }) => {
  const unexpected = await openLongGroupLoad(page, { width: 1024, height: 700 });
  await page.getByRole("button", { name: "Open camera", exact: true }).click();
  await expect(page.locator("#fulfillmentCamera")).toBeVisible();

  const layout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".fulfillment-screen > .fulfillment-card")];
    const photoCard = cards[0];
    const lineCard = cards[1];
    const list = document.querySelector(".fulfillment-lines");
    const photoRect = photoCard.getBoundingClientRect();
    const lineRect = lineCard.getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(photoRect.right, lineRect.right) - Math.max(photoRect.left, lineRect.left));
    const overlapHeight = Math.max(0, Math.min(photoRect.bottom, lineRect.bottom) - Math.max(photoRect.top, lineRect.top));
    return {
      overflowY: getComputedStyle(list).overflowY,
      listScrollHeight: list.scrollHeight,
      listClientHeight: list.clientHeight,
      overlapArea: overlapWidth * overlapHeight
    };
  });

  expect(layout.overflowY).toBe("auto");
  expect(layout.listScrollHeight).toBeGreaterThan(layout.listClientHeight);
  expect(layout.overlapArea).toBe(0);

  const capture = page.locator('[data-action="capture-photo"]');
  await capture.scrollIntoViewIfNeeded();
  await expect(capture).toBeVisible();
  const interceptedBy = await capture.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
    return target === button || button.contains(target) ? null : target?.className || target?.tagName || "outside";
  });
  expect(interceptedBy).toBeNull();
  expect(unexpected).toEqual([]);
});

test("phone layout stacks the packed-line card below the photo card", async ({ page }) => {
  await openLongGroupLoad(page, { width: 390, height: 844 });
  const cards = page.locator(".fulfillment-screen > .fulfillment-card");
  await expect(cards).toHaveCount(2);
  const positions = await cards.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  }));
  expect(positions[1].top).toBeGreaterThanOrEqual(positions[0].bottom - 1);
  await expect(page.locator(".fulfillment-screen")).toHaveCSS("overflow-y", "auto");
});
