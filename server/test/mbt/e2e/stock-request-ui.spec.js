import { readFile } from "node:fs/promises";

import { expect, test } from "./mbt-e2e-test.js";

/* global document, localStorage, window */

test.use({ serviceWorkers: "block" });

const currentAssets = Object.freeze({
  "/i18n.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/i18n.js", import.meta.url), "utf8")
  },
  "/sales-stock-requests.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/sales-stock-requests.js", import.meta.url), "utf8")
  },
  "/scm-stock-requests.js": {
    contentType: "text/javascript",
    body: await readFile(new URL("../../../public/scm-stock-requests.js", import.meta.url), "utf8")
  },
  "/stock-requests.css": {
    contentType: "text/css",
    body: await readFile(new URL("../../../public/stock-requests.css", import.meta.url), "utf8")
  }
});

function stockRequestLine(id, label) {
  return {
    id: id * 10,
    itemId: 7000 + id,
    itemName: `${label}-ITEM`,
    itemDescription: `${label} result`,
    sourceLocationId: 28,
    sourceName: "Calgary",
    destinationLocationId: 1,
    destinationName: "Vancouver",
    status: "submitted",
    salesQty: 80,
    salesUom: "SQ FT",
    quantityMode: "conversion",
    pallets: 2,
    layers: 0,
    sections: 0,
    pieces: 0,
    toPlt: 40,
    toLyr: 10,
    toSec: 5,
    toPcs: 1,
    decisionReason: null
  };
}

function stockRequestFixture(id, label) {
  const line = stockRequestLine(id, label);
  return {
    id,
    requestRef: `STREQ-${label}`,
    status: "submitted",
    bucket: "pending",
    destinationLocationId: 1,
    destinationName: "Vancouver",
    requestedBy: "browser-sales",
    requestedByName: "Browser Sales",
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    revision: 1,
    firstScmDecisionAt: null,
    remarks: "Browser-visible request remark",
    lines: [line],
    transfers: [],
    events: [],
    availability: [{
      item: {
        itemId: line.itemId,
        itemCode: line.itemName,
        salesUom: line.salesUom,
        toPlt: line.toPlt,
        toLyr: line.toLyr,
        toSec: line.toSec,
        toPcs: line.toPcs
      },
      yards: [{
        locationId: 28,
        yardCode: "Calgary",
        liveAvailable: 120,
        activeReserved: 40,
        requestableAvailable: 80
      }]
    }]
  };
}

function listPayload(requests, role) {
  return {
    requests,
    ...(role === "sales" ? {
      yards: [{ locationId: 1, yardCode: "Vancouver" }],
      filterOptions: {
        vendors: ["Browser Vendor"],
        sourceYards: [{ locationId: 28, yardCode: "Calgary" }]
      }
    } : {
      filterOptions: {
        vendors: ["Browser Vendor"],
        sourceYards: [{ locationId: 28, yardCode: "Calgary" }],
        destinationYards: [{ locationId: 1, yardCode: "Vancouver" }]
      }
    })
  };
}

async function installCurrentAssets(page) {
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const asset = currentAssets[pathname];
    if (!asset) {
      return route.fallback();
    }
    return route.fulfill({ status: 200, ...asset });
  });
}

async function installStockSession(page, role) {
  await page.addInitScript(({ grantedRole }) => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.staff.token", "stock-request-browser-token");
    localStorage.setItem("mbbs.staff.role", grantedRole);
    localStorage.setItem("mbbs.staff.roles", JSON.stringify([grantedRole]));
    localStorage.removeItem("mbbs.sales.stockRequests.selected");
    localStorage.removeItem("mbbs.scm.stockRequests.selected");
    localStorage.setItem("mbbs.sales.stockRequests.bucket", "pending");
    localStorage.setItem("mbbs.scm.stockRequests.queue", "request");
  }, { grantedRole: role });
}

function fulfillJson(route, value, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function fulfillStockList(route, url, { failList, fixtures, role, state }) {
  if (failList) {
    return fulfillJson(route, { error: "Compact browser regression error" }, 500);
  }
  const search = url.searchParams.get("search") || "";
  state.queries.push(search);
  if (search === "S") {
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (search === "SO") {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const requests = search === "S"
    ? [fixtures.get(1)]
    : search === "SO"
      ? [fixtures.get(2)]
      : [];
  return fulfillJson(route, listPayload(requests, role));
}

function fulfillStockDecision(route, request, url, fixtures, state) {
  const requestId = Number(url.pathname.split("/").at(-2));
  const fixture = fixtures.get(requestId);
  if (!fixture) {
    return fulfillJson(route, { error: "Unknown browser fixture" }, 404);
  }
  const decision = request.postDataJSON();
  state.decisions.push(decision);
  fixture.revision += 1;
  for (const line of fixture.lines) {
    if (decision.lineIds.includes(line.id)) {
      line.status = decision.decision === "reject" ? "rejected" : "changes_requested";
      line.decisionReason = decision.reason;
    }
  }
  fixture.status = "completed";
  fixture.bucket = decision.decision === "reject" ? "rejected" : "returned";
  return fulfillJson(route, fixture);
}

async function installStockApi(page, role, { failList = false } = {}) {
  const state = { queries: [], decisions: [] };
  const prefix = `/api/${role}/stock-requests`;
  const fixtures = new Map([
    [1, stockRequestFixture(1, "OLD")],
    [2, stockRequestFixture(2, "NEW")]
  ]);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      return fulfillJson(route, {
        operator: {
          id: `browser-${role}`,
          username: `browser-${role}`,
          display_name: `Browser ${role.toUpperCase()}`,
          role,
          roles: [role]
        }
      });
    }
    if (url.pathname === prefix) {
      return fulfillStockList(route, url, { failList, fixtures, role, state });
    }
    if (request.method() === "POST" && url.pathname.startsWith(`${prefix}/`) && url.pathname.endsWith("/line-decisions")) {
      return fulfillStockDecision(route, request, url, fixtures, state);
    }
    if (url.pathname.startsWith(`${prefix}/`)) {
      const fixture = fixtures.get(Number(url.pathname.slice(prefix.length + 1)));
      return fixture
        ? fulfillJson(route, fixture)
        : fulfillJson(route, { error: "Unknown browser fixture" }, 404);
    }
    return fulfillJson(route, { error: `Unhandled browser API ${request.method()} ${url.pathname}` }, 404);
  });
  return state;
}

for (const role of ["sales", "scm"]) {
  test(`${role.toUpperCase()} search retains focus/caret and ignores a late older result`, async ({ page }) => {
    await installCurrentAssets(page);
    await installStockSession(page, role);
    const state = await installStockApi(page, role);
    const path = role === "sales" ? "/sales/stock-requests" : "/scm/stock-requests";
    const inputSelector = role === "sales" ? "[data-sales-stock-search]" : "[data-scm-stock-search]";

    await page.goto(path);
    const input = page.locator(inputSelector);
    await expect(input).toBeVisible();
    await input.fill("S");
    await expect.poll(() => state.queries.includes("S")).toBe(true);
    await input.press("End");
    await input.type("O");

    await expect(page.getByRole("heading", { name: "STREQ-NEW", exact: true })).toBeVisible();
    await page.waitForTimeout(950);
    await expect(page.getByText("STREQ-OLD", { exact: true })).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("SO");
    expect(await input.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([2, 2]);

    if (role === "scm") {
      await expect(page.getByText("Browser-visible request remark", { exact: false })).toBeVisible();
      const primary = await page.locator(".stock-request-availability-primary").first().boundingBox();
      const equivalents = await page.locator(".stock-request-availability-equivalents").first().boundingBox();
      expect(primary).not.toBeNull();
      expect(equivalents).not.toBeNull();
      expect(equivalents.y).toBeGreaterThanOrEqual(primary.y + primary.height - 1);
    }
  });
}

test("SCM Reject defaults to all actionable lines and uses an in-page required reason", async ({ page }) => {
  await installCurrentAssets(page);
  await installStockSession(page, "scm");
  const state = await installStockApi(page, "scm");

  await page.goto("/scm/stock-requests");
  const search = page.locator("[data-scm-stock-search]");
  await search.fill("SO");
  await expect(page.getByRole("heading", { name: "STREQ-NEW", exact: true })).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);

  const reject = page.getByRole("button", { name: "Reject all actionable", exact: true });
  await expect(reject).toBeEnabled();
  await expect(page.locator("[data-scm-stock-select-line]:checked")).toHaveCount(0);
  await reject.click();

  const editor = page.getByRole("dialog", { name: "Reject stock-request lines" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Confirm Reject", exact: true }).click();
  await expect(page.getByText("Reject requires a reason.", { exact: true })).toBeVisible();
  expect(state.decisions).toEqual([]);
  await editor.getByLabel("Reject reason").fill("Requested material is no longer required");
  await editor.getByRole("button", { name: "Confirm Reject", exact: true }).click();

  await expect.poll(() => state.decisions).toEqual([{
    expectedRevision: 1,
    lineIds: [20],
    decision: "reject",
    reason: "Requested material is no longer required"
  }]);
  await expect(page.getByText("Selected request line(s) were rejected.", { exact: true })).toBeVisible();
});

test("stock-request error feedback remains compact on the current viewport", async ({ page }) => {
  await installCurrentAssets(page);
  await installStockSession(page, "sales");
  await installStockApi(page, "sales", { failList: true });

  await page.goto("/sales/stock-requests");
  const notice = page.locator(".stock-request-notice.stock-request-error");
  await expect(notice).toContainText("Compact browser regression error");
  const box = await notice.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box.height).toBeLessThan(viewport.height / 3);
});

test("Sales Request Stock renders its full working surface in Simplified Chinese", async ({ page }) => {
  await installCurrentAssets(page);
  await installStockSession(page, "sales");
  await page.addInitScript(() => localStorage.setItem("mbbs.ui.language", "zh-CN"));
  await installStockApi(page, "sales");

  await page.goto("/sales/stock-requests");
  await expect(page.getByRole("heading", { name: "申请库存", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建申请", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "待处理", exact: true })).toBeVisible();
  await expect(page.getByText("物品供应商", { exact: true })).toBeVisible();
  const search = page.locator("[data-sales-stock-search]");
  await expect(search).toHaveAttribute("placeholder", "搜索申请编号或物品");
  await search.fill("SO");
  await expect(page.getByRole("heading", { name: "STREQ-NEW", exact: true })).toBeVisible();
  await expect(page.getByText("销售备注：", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "申请物品", exact: true })).toBeVisible();
});
