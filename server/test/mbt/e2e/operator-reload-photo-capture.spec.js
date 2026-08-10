import { expect, test } from "./mbt-e2e-test.js";
import { readFile } from "node:fs/promises";

/* global HTMLMediaElement, HTMLVideoElement, MediaStream, document, getComputedStyle, localStorage, navigator, window */

test.use({ serviceWorkers: "block" });

const reloadOrder = {
  netsuite_id: "928827",
  tranid: "SOB116330",
  order_type: "sales_order",
  customer: "Reload photo regression",
  outbound_location_id: 15,
  outbound_location: "12441",
  operator_status: "packed",
  local_yard_order_status: "Reload Packed",
  dispatch_planned: true,
  dispatch_plan_date: "2026-08-07",
  dispatch_truck_plate: "BD98773",
  dispatch_load_name: "Load 1",
  reload_authorized: true,
  reload_reason: "Reload photo regression",
  reload_cycle: {
    id: "reload-cycle-1",
    cycleNumber: 1,
    status: "packed",
    reason: "Reload photo regression"
  },
  lines: [
    {
      id: "reload-line-1",
      line_id: "1",
      item_id: "1001",
      item_name: "Reload item",
      sku: "RELOAD-ITEM",
      item_description: "Packed reload line",
      item_type: "InvtPart",
      quantity: 1,
      unit: "EA",
      pallet_qty: 1,
      layer_qty: 0,
      section_qty: 0,
      piece_qty: 0,
      packed_pallet_qty: 1,
      packed_layer_qty: 0,
      packed_section_qty: 0,
      packed_piece_qty: 0,
      packed_sales_qty: 1,
      loaded_qty: 0,
      reload_remaining_sales_qty: 1,
      netsuite_active: true,
      confirmed: true,
      reload_line: true
    }
  ]
};

const operatorCss = await readFile(new URL("../../../public/operator.css", import.meta.url), "utf8");
const operatorJs = await readFile(new URL("../../../public/operator.js", import.meta.url), "utf8");

async function installReloadAssets(page) {
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

async function installReloadApi(page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value)
    });

    if (url.pathname === "/api/auth/me") {
      return json({
        operator: {
          id: "reload-test-operator",
          username: "reload-test",
          display_name: "Reload Test Operator",
          role: "operator",
          roles: ["operator"]
        }
      });
    }
    if (url.pathname === "/api/delivery/notifications") {
      return json({ total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] });
    }
    if (url.pathname === "/api/delivery/current-draft") {
      return json(null);
    }
    if (url.pathname === "/api/delivery/saved-order-keys") {
      return json([]);
    }
    if (url.pathname === "/api/operator/requests") {
      return json([]);
    }
    if (url.pathname === "/api/delivery/load-trucks") {
      return json([{ truck_plate: "BD98773", load_count: 1, order_count: 1, first_load_name: "Load 1" }]);
    }
    if (url.pathname === "/api/delivery/load-orders") {
      return json([reloadOrder]);
    }
    if (url.pathname === "/api/delivery/orders/928827") {
      return json(reloadOrder);
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `Unhandled ${url.pathname}` }) });
  });
}

async function installVirtualRearCamera(page) {
  await page.addInitScript(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };

    const cameraTrack = {
      stop() {},
      getSettings() {
        return { deviceId: "virtual-rear-camera" };
      },
      getCapabilities() {
        return {};
      },
      async applyConstraints() {}
    };
    const stream = new MediaStream();
    stream.getTracks = () => [cameraTrack];
    stream.getVideoTracks = () => [cameraTrack];

    window.__reloadCameraOpenCount = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async enumerateDevices() {
          return [{ kind: "videoinput", deviceId: "virtual-rear-camera", label: "Back Camera" }];
        },
        async getUserMedia() {
          window.__reloadCameraOpenCount += 1;
          return stream;
        }
      }
    });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 720 });
    HTMLMediaElement.prototype.play = async () => {};
    window.ImageCapture = class {
      async getPhotoCapabilities() {
        return { imageWidth: { max: 1280 }, imageHeight: { max: 720 } };
      }
      async takePhoto() {
        return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" });
      }
    };

    localStorage.setItem("mbbs.staff.token", "reload-test-token");
    localStorage.setItem("mbbs.operator.token", "reload-test-token");
    localStorage.setItem("mbbs.operator.locationId", "15");
    localStorage.setItem("mbbs.operator.deliveryPrepMode", "load");
    localStorage.setItem("mbbs.operator.deliveryLoadViewDate", "2026-08-07");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({
      currentModule: "delivery",
      locationId: 15,
      viewMode: "active",
      deliveryOrderType: "sales_order",
      deliveryPrepMode: "load",
      deliveryLoadViewDate: "2026-08-07",
      selectedId: "928827",
      selectedLineId: "reload-line-1"
    }));
  });
}

test("packed reload load screen opens the camera and captures two photos", async ({ page }) => {
  if (process.env.MBT_TEST_USE_LIVE_ASSETS !== "1") {
    await installReloadAssets(page);
  }
  await installReloadApi(page);
  await installVirtualRearCamera(page);

  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: "SOB116330" })).toBeVisible();

  await page.getByRole("button", { name: "Take Photos & Re-load" }).first().click();
  await expect(page.getByText("Local-only re-load")).toBeVisible();
  await expect(page.getByRole("button", { name: "Capture photo 1" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__reloadCameraOpenCount)).toBe(1);
  const clippedCameraControls = await page.locator("#fulfillmentCamera, [data-action='capture-photo']").evaluateAll((elements) => {
    const clipsBounds = (scrollable, overflow, start, end, ancestorStart, ancestorEnd) => (
      !scrollable
      && ["hidden", "clip"].includes(overflow)
      && (start < ancestorStart || end > ancestorEnd)
    );
    return elements.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      let verticallyScrollable = false;
      let horizontallyScrollable = false;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        const clippedVertically = clipsBounds(
          verticallyScrollable,
          style.overflowY,
          rect.top,
          rect.bottom,
          ancestorRect.top,
          ancestorRect.bottom
        );
        const clippedHorizontally = clipsBounds(
          horizontallyScrollable,
          style.overflowX,
          rect.left,
          rect.right,
          ancestorRect.left,
          ancestorRect.right
        );
        if (clippedVertically || clippedHorizontally) {
          return [{
            element: element.id || element.getAttribute("data-action"),
            clippedBy: ancestor.className || ancestor.tagName,
            rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
            ancestorRect: {
              top: ancestorRect.top,
              right: ancestorRect.right,
              bottom: ancestorRect.bottom,
              left: ancestorRect.left
            }
          }];
        }
        if (["auto", "scroll"].includes(style.overflowY)) {
          verticallyScrollable = true;
        }
        if (["auto", "scroll"].includes(style.overflowX)) {
          horizontallyScrollable = true;
        }
      }
      return [];
    });
  });
  expect(clippedCameraControls).toEqual([]);

  const firstCapture = page.getByRole("button", { name: "Capture photo 1" });
  await firstCapture.scrollIntoViewIfNeeded();
  const pointerInterceptor = await firstCapture.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
    return target === button || button.contains(target)
      ? null
      : target?.className || target?.tagName || "outside viewport";
  });
  expect(pointerInterceptor).toBeNull();
  await firstCapture.click();
  await expect(page.locator('[data-action="select-fulfillment-photo-slot"]').nth(0)).toContainText("Ready");

  await page.getByRole("button", { name: "Capture photo 2" }).click();
  await expect(page.locator('[data-action="select-fulfillment-photo-slot"]').nth(1)).toContainText("Ready");
  await expect(page.getByRole("button", { name: "Load", exact: true })).toBeEnabled();
});
