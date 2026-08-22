import { readFile } from "node:fs/promises";

import { expect, test } from "./mbt-e2e-test.js";

/* global localStorage, window */

test.use({ serviceWorkers: "block" });

const PICKUP_ORDER_ID = "9988171";
const PO_ORDER_ID = "9988172";

const currentAssets = Object.freeze({
  "/i18n.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/i18n.js", import.meta.url), "utf8")
  },
  "/operator.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8")
  }
});

function fulfillJson(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function installCurrentAssets(page) {
  await page.route("**/*", async (route) => {
    const asset = currentAssets[new URL(route.request().url()).pathname];
    return asset
      ? route.fulfill({ status: 200, ...asset })
      : route.fallback();
  });
}

async function installSession(page, state) {
  await page.addInitScript((restoredState) => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.staff.token", "operator-page-confirm-browser-token");
    localStorage.setItem("mbbs.operator.token", "operator-page-confirm-browser-token");
    localStorage.setItem("mbbs.operator.locationId", "1");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({ locationId: 1, ...restoredState }));
  }, state);
}

function commonApi(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/api/auth/me") {
    return fulfillJson(route, {
      operator: {
        id: "operator-page-confirm-browser-operator",
        username: "operator-page-confirm-browser-operator",
        display_name: "Page Confirm Operator",
        role: "operator",
        roles: ["operator"]
      }
    });
  }
  if (pathname === "/api/delivery/notifications") {
    return fulfillJson(route, {
      total: 0,
      salesOrder: { dueToday: 0 },
      transferOrder: { dueToday: 0 },
      items: []
    });
  }
  if (pathname === "/api/delivery/current-draft") {
    return fulfillJson(route, null);
  }
  return null;
}

function pageLine(id, sku, quantity) {
  return {
    id,
    line_id: id,
    item_id: id,
    item_name: sku,
    sku,
    item_description: `${sku} visible page line`,
    item_type: "InvtPart",
    quantity,
    unit: "PC",
    piece_qty: quantity,
    packed_piece_qty: 0,
    packed_pallet_qty: 0,
    packed_layer_qty: 0,
    packed_section_qty: 0,
    packed_sales_qty: 0,
    received_piece_qty: 0,
    received_pallet_qty: 0,
    received_layer_qty: 0,
    received_section_qty: 0,
    received_sales_qty: 0,
    netsuite_received_qty: 0,
    loaded_qty: 0,
    to_pcs: 1,
    netsuite_active: true,
    confirmed: false
  };
}

test("Customer Pickup confirms every visible line on the current page", async ({ page }) => {
  const order = {
    netsuite_id: PICKUP_ORDER_ID,
    tranid: "SO-PICKUP-PAGE-CONFIRM",
    order_type: "sales_order",
    delivery_method: "Pick-Up",
    customer: "Page Confirm Pickup Customer",
    trandate: "2026-08-15",
    outbound_location_id: 1,
    outbound_location: "3445",
    operator_status: "open",
    local_yard_order_status: "Open",
    lines: [
      pageLine("pickup-page-line-1", "PICKUP-PAGE-1", 2),
      pageLine("pickup-page-line-2", "PICKUP-PAGE-2", 3)
    ]
  };
  const state = { bodies: [], unexpected: [] };

  await installCurrentAssets(page);
  await installSession(page, {
    currentModule: "customer-pickup",
    selectedId: PICKUP_ORDER_ID,
    selectedLineId: "pickup-page-line-1",
    linePage: 0
  });
  await page.route("**/api/**", async (route) => {
    const commonResponse = commonApi(route);
    if (commonResponse) {
      return commonResponse;
    }
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === `/api/delivery/orders/${PICKUP_ORDER_ID}`) {
      return fulfillJson(route, order);
    }
    if (pathname === `/api/customer-pickup/orders/${PICKUP_ORDER_ID}/lines/confirm-page` && request.method() === "POST") {
      const body = request.postDataJSON();
      state.bodies.push(body);
      for (const requested of body.lines || []) {
        const line = order.lines.find((item) => String(item.id) === String(requested.lineId));
        if (!line) {
          continue;
        }
        line.packed_piece_qty = Number(requested.values?.pieces || 0);
        line.confirmed = line.packed_piece_qty > 0;
      }
      return fulfillJson(route, { ok: true, confirmed: body.lines.length, failures: [], order });
    }
    state.unexpected.push(`${request.method()} ${pathname}`);
    return fulfillJson(route, { error: `Unhandled fixture ${request.method()} ${pathname}` }, 404);
  });

  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: "SO-PICKUP-PAGE-CONFIRM", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm page", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("2 line confirmed");

  expect(state.bodies).toHaveLength(1);
  expect(state.bodies[0].lines.map((line) => line.lineId)).toEqual([
    "pickup-page-line-1",
    "pickup-page-line-2"
  ]);
  expect(state.unexpected).toEqual([]);
});

test("PO Receiving confirms every visible line while retaining PO scope", async ({ page }) => {
  const order = {
    netsuite_id: PO_ORDER_ID,
    tranid: "PO-PAGE-CONFIRM",
    order_type: "purchase_order",
    vendor: "Page Confirm Vendor",
    trandate: "2026-08-15",
    status_text: "Purchase Order : Pending Receipt",
    destination_location_id: 1,
    destination_location: "3445",
    line_count: 2,
    lines: [
      pageLine("po-page-line-1", "PO-PAGE-1", 4),
      pageLine("po-page-line-2", "PO-PAGE-2", 5)
    ]
  };
  const state = { bodies: [], unexpected: [] };

  await installCurrentAssets(page);
  await installSession(page, {
    currentModule: "receiving",
    receivingStep: "orders",
    receivingOrderType: "purchase_order",
    receivingSelectedVendor: "Page Confirm Vendor",
    receivingSelectedId: PO_ORDER_ID,
    receivingSelectedLineId: "po-page-line-1",
    receivingLinePage: 0
  });
  await page.route("**/api/**", async (route) => {
    const commonResponse = commonApi(route);
    if (commonResponse) {
      return commonResponse;
    }
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const routeKey = `${request.method()} ${pathname}`;
    switch (routeKey) {
      case "GET /api/receiving/vendors":
        return fulfillJson(route, [{ vendor: "Page Confirm Vendor", order_count: 1 }]);
      case "GET /api/receiving/orders":
        return fulfillJson(route, [order]);
      case `GET /api/receiving/orders/${PO_ORDER_ID}`:
        return fulfillJson(route, order);
      case `POST /api/receiving/orders/${PO_ORDER_ID}/lines/confirm-page`: {
        const body = request.postDataJSON();
        state.bodies.push(body);
        for (const requested of body.lines || []) {
          const line = order.lines.find((item) => String(item.id) === String(requested.lineId));
          if (!line) {
            continue;
          }
          line.received_piece_qty = Number(requested.values?.pieces || 0);
        }
        return fulfillJson(route, { ok: true, confirmed: body.lines.length, failures: [], order });
      }
      default:
        state.unexpected.push(`${request.method()} ${pathname}`);
        return fulfillJson(route, { error: `Unhandled fixture ${request.method()} ${pathname}` }, 404);
    }
  });

  await page.goto("/operator");
  const detailHeading = page.getByRole("heading", { name: "PO-PAGE-CONFIRM", exact: true });
  await detailHeading.scrollIntoViewIfNeeded();
  await expect(detailHeading).toBeVisible();
  await page.getByRole("button", { name: "Confirm page", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("2 line confirmed");

  expect(state.bodies).toHaveLength(1);
  expect(state.bodies[0]).toEqual(expect.objectContaining({ orderType: "purchase_order" }));
  expect(state.bodies[0].lines.map((line) => line.lineId)).toEqual([
    "po-page-line-1",
    "po-page-line-2"
  ]);
  expect(state.unexpected).toEqual([]);
});
