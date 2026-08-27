import { expect, test } from "./mbt-e2e-test.js";

/* global localStorage, window */

test.use({ serviceWorkers: "block" });

const orderSummary = Object.freeze({
  direction: "outbound",
  order_type: "sales_order",
  order_id: "945867",
  tranid: "SOM05681",
  yard_location: "12441",
  movement_status: "Delivered",
  last_activity_at: "2026-08-15T16:51:58.929Z",
  yard_activity_count: 1,
  driver_activity_count: 2,
  photo_count: 2
});

function loadedDetail(corrected) {
  return {
    order: {
      ...orderSummary,
      source_location: "12441",
      destination_location: "77 Clarence St, Woodbridge, ON L4L 1L4",
      delivery_at: "2026-08-15T16:51:58.929Z",
      driver_only: false
    },
    lines: [{
      sku: "UNI-WIN70T-RDM-GN",
      item_name: "UNI-WIN70T-RDM-GN",
      item_description: "Windermere Granite Blend",
      processed_qty: 1470.08,
      processed_uom: "SQFT",
      processed_pallet_qty: 16,
      to_plt: 91.88,
      location: "12441"
    }],
    photos: [],
    loadAttempts: [],
    activeReloadCycle: null,
    driverRecords: [],
    driverPhotos: [],
    latestReattemptCycle: {
      id: 2,
      reattemptOrderRef: "SOM05681-R1",
      status: "completed",
      completionSource: "driver_completion_reconciliation",
      operatorLoadEvidenceMissing: true,
      lines: [{
        netsuiteLineId: 4760329,
        skuMismatch: true,
        itemMismatch: true,
        identityCorrected: corrected
      }]
    }
  };
}

function correctionPreview() {
  return {
    preview: {
      orderRef: "SOM05681-R1",
      parentOrderRef: "SOM05681",
      childStatus: "completed",
      cycleStatus: "authorized",
      warning: "Operator load evidence is absent. Applying the correction reconciles the cycle from immutable Driver completion without creating a load record.",
      lines: [{
        netsuiteLineId: 4760329,
        requiresCorrection: true,
        currentQuantitySupportsTarget: true,
        beforeSku: "UNI-WIN70T-RDM-CG",
        afterSku: "UNI-WIN70T-RDM-GN",
        afterSalesUom: "SQFT",
        historicalSku: "UNI-WIN70T-RDM-CG",
        targetSalesQty: 1470.08,
        targetPalletQty: 16,
        expectedStateFingerprint: "a".repeat(64)
      }]
    }
  };
}

function fulfillJson(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload)
  });
}

async function installSession(page) {
  await page.addInitScript(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.control.token", "reattempt-browser-admin-token");
    localStorage.setItem("mbbs.staff.token", "reattempt-browser-admin-token");
    localStorage.setItem("mbbs.staff.role", "admin");
    localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
    localStorage.setItem("mbbs.control.section", "loaded-export");
    localStorage.setItem("mbbs.control.loaded.direction", "outbound");
    localStorage.setItem("mbbs.control.loaded.outboundType", "sales_order");
  });
}

async function installApi(page) {
  const state = { corrected: false, commands: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === "/api/auth/bootstrap-needed") {
      return fulfillJson(route, { needed: false });
    }
    if (pathname === "/api/auth/me") {
      return fulfillJson(route, {
        operator: {
          id: "reattempt-browser-admin",
          username: "reattempt-browser-admin",
          display_name: "Re-attempt Browser Admin",
          role: "admin",
          roles: ["admin"]
        }
      });
    }
    if (pathname === "/api/control/loaded-orders/drivers") {
      return fulfillJson(route, []);
    }
    if (pathname === "/api/control/loaded-orders/detail") {
      return fulfillJson(route, loadedDetail(state.corrected));
    }
    if (pathname === "/api/control/loaded-orders") {
      return fulfillJson(route, [orderSummary]);
    }
    if (pathname.endsWith("/current-item-correction-preview")) {
      return fulfillJson(route, correctionPreview());
    }
    if (pathname.endsWith("/current-item-corrections") && request.method() === "POST") {
      state.commands.push(request.postDataJSON());
      state.corrected = true;
      return fulfillJson(route, {
        idempotent: false,
        correction: { correctionId: 44 },
        preview: { parentSalesOrderId: 945867, cycleId: 2, parentOrderRef: "SOM05681" }
      }, 201);
    }
    if (pathname === "/api/returns") {
      return fulfillJson(route, { records: [], counts: {} });
    }
    return fulfillJson(route, []);
  });
  return state;
}

test("Admin confirms the GN overlay while the Control UI keeps historical CG visible", async ({ page }) => {
  await installSession(page);
  const state = await installApi(page);
  await page.goto("/control/yard-in-outbound");

  const correctionButton = page.getByRole("button", { name: "Correct re-attempt item" });
  await expect(correctionButton).toBeVisible();
  await correctionButton.click();

  const dialog = page.getByRole("dialog", { name: "Correct re-attempt current item" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    bodyLocked: document.body.classList.contains("sales-order-reload-open"),
    documentLocked: document.documentElement.classList.contains("sales-order-reload-open"),
    scrollX: window.scrollX,
    scrollY: window.scrollY
  }))).toEqual({ bodyLocked: true, documentLocked: true, scrollX: 0, scrollY: 0 });
  const modalGeometry = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const overflowChildren = Array.from(element.children).map((child) => {
      const childBounds = child.getBoundingClientRect();
      return {
        className: child.className,
        tagName: child.tagName,
        left: childBounds.left,
        right: childBounds.right,
        width: childBounds.width
      };
    }).filter((child) => child.left < bounds.left - 1 || child.right > bounds.right + 1);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: bounds.left,
      right: bounds.right,
      viewportWidth: window.innerWidth,
      bodyPaddingLeft: getComputedStyle(document.body).paddingLeft,
      overflowChildren
    };
  });
  expect(
    modalGeometry.scrollWidth - modalGeometry.clientWidth,
    JSON.stringify(modalGeometry)
  ).toBeLessThanOrEqual(1);
  await expect(dialog.getByText("Effective/current item", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Historical first-attempt item", { exact: true })).toBeVisible();
  await expect(dialog.getByText("UNI-WIN70T-RDM-GN", { exact: true })).toBeVisible();
  await expect(dialog.getByText("UNI-WIN70T-RDM-CG", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Original load evidence, Driver photos, timestamps/u)).toBeVisible();
  await expect(dialog.getByText(/Operator load evidence is absent/u).first()).toBeVisible();

  await dialog.getByRole("radio").check();
  await dialog.getByRole("textbox", { name: "Mandatory correction reason" })
    .fill("Physically verified against Sety's completed second delivery");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Apply append-only correction" }).click();

  await expect(dialog).toBeHidden();
  await expect(correctionButton).toBeHidden();
  expect(state.commands).toHaveLength(1);
  expect(state.commands[0]).toEqual(expect.objectContaining({
    netsuiteLineId: 4760329,
    expectedStateFingerprint: "a".repeat(64),
    physicallyDeliveredCurrentItem: true
  }));
});
