// @ts-check

import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const USERNAME = `p35-asset-csv-e2e-${RUN_ID}`;
const PASSWORD = "mbt-test-p35-asset-csv-browser";
const BATCH_ID = "35353535-3535-4353-8353-353535353537";
const ASSET_ID = "35353535-3535-4353-8353-353535353538";
const NORMALIZED_HASH = "a".repeat(64);
const TARGET_REVISION_HASH = "b".repeat(64);
const ASSET_CODE = `P35CSV-E2E_${RUN_ID.toUpperCase()}-14`;
const file = Object.freeze({
  fileName: "mbt-bin-assets-v2.csv",
  content: [
    "asset_code,item_code,current_address,active,under_maintenance,occurred_at",
    `${ASSET_CODE},14YD,"12441 Woodbine Avenue, Whitchurch-Stouffville, ON",true,false,2036-08-03T12:34:56.000Z`
  ].join("\r\n")
});
const previewRows = Object.freeze([
  {
    rowNumber: 2,
    assetCode: ASSET_CODE,
    itemCode: "14YD",
    currentAddress: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
    active: true,
    underMaintenance: false,
    occurredAt: "2036-08-03T12:34:56.000Z"
  }
]);
const importedAsset = Object.freeze({
  assetId: ASSET_ID,
  assetCode: previewRows[0].assetCode,
  itemCode: "14YD",
  itemDisplayName: "14 yard bin",
  binTypeCode: "14YD",
  active: true,
  underMaintenance: false,
  revision: 1,
  currentState: Object.freeze({
    lifecycleStatus: "available",
    locationKind: "yard",
    locationReference: "12441",
    currentAddress: previewRows[0].currentAddress,
    revision: 1
  })
});

async function removeFixture() {
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [USERNAME]
  );
  await query("DELETE FROM operators WHERE username = $1", [USERNAME]);
}

async function tokenFor(request) {
  const response = await request.post("/api/auth/login", {
    data: { username: USERNAME, password: PASSWORD }
  });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

async function openAssets(page, request) {
  const token = await tokenFor(request);
  await page.goto("/");
  await page.evaluate((value) => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "admin");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
  }, token);
  await page.goto("/mbt/assets");
}

function json(route, status, body, headers = {}) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store", ...headers },
    body: JSON.stringify(body)
  });
}

async function installAssetApi(page) {
  const calls = [];
  const state = { applied: false };
  await page.route("**/api/mbt/assets**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/mbt/assets/import/template") {
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        headers: {
          "cache-control": "no-store",
          "content-disposition": "attachment; filename=mbt-bin-assets-v2.csv"
        },
        body: "asset_code,item_code,current_address,active,under_maintenance,occurred_at\r\n"
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/mbt/assets/import/preview") {
      calls.push({
        method: "preview",
        contentType: request.headers()["content-type"],
        fileName: request.headers()["x-mbt-source-filename"],
        body: request.postDataBuffer()?.toString("utf8")
      });
      await json(route, 201, {
        schemaVersion: "mbt-bin-assets-import-preview-v1",
        batchId: BATCH_ID,
        status: "previewed",
        fileHash: "c".repeat(64),
        normalizedHash: NORMALIZED_HASH,
        targetRevisionToken: TARGET_REVISION_HASH,
        summary: { rowCount: 1 },
        rows: previewRows
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === `/api/mbt/assets/import/${BATCH_ID}/apply`) {
      calls.push({
        method: "apply",
        idempotencyKey: request.headers()["idempotency-key"],
        body: request.postDataJSON()
      });
      state.applied = true;
      await json(route, 201, {
        schemaVersion: "mbt-bin-assets-import-apply-v1",
        batchId: BATCH_ID,
        status: "applied",
        normalizedHash: NORMALIZED_HASH,
        summary: { created: 1 },
        items: [{ rowNumber: 2, assetId: ASSET_ID, assetCode: importedAsset.assetCode, revision: 1 }]
      }, { "x-mbt-idempotent-replay": "false" });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/mbt/assets") {
      await json(route, 200, {
        schemaVersion: "mbt-assets-v1",
        items: state.applied ? [importedAsset] : [],
        nextCursor: null
      });
      return;
    }
    await json(route, 404, { error: "Unexpected synthetic asset route" });
  });
  return calls;
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "P3.5a Asset CSV Browser",
    password: PASSWORD,
    role: "admin",
    roles: ["admin"]
  });
});

test.afterAll(async () => {
  await removeFixture();
});

test("P3-F11 CSV browser: download, raw preview, evidence table, and atomic apply are functional", async ({
  page,
  request
}) => {
  const calls = await installAssetApi(page);
  await openAssets(page, request);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /download.*template/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("mbt-bin-assets-v2.csv");

  await page.locator("#assetCsvFile").setInputFiles({
    name: file.fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(file.content, "utf8")
  });
  await page.getByRole("button", { name: /preview.*server/i }).click();
  await expect(page.locator("#assetCsvPreviewRows")).toContainText(previewRows[0].assetCode);
  await expect(page.locator("#assetCsvPreviewRows")).toContainText("14YD");
  await expect(page.locator("#assetCsvApply")).toBeDisabled();
  await page.locator("#assetCsvReason").fill("Approve synthetic opening inventory");
  await expect(page.locator("#assetCsvApply")).toBeEnabled();
  await page.locator("#assetCsvApply").click();
  await expect(page.locator("#assetReconciliationMessage")).toContainText(/1 asset.*registered/i);
  await expect(page.locator("#assetRows")).toContainText(importedAsset.assetCode);

  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    method: "preview",
    fileName: file.fileName,
    body: file.content
  });
  expect(calls[0].contentType).toContain("text/csv");
  expect(calls[1].method).toBe("apply");
  expect(calls[1].idempotencyKey).toMatch(/^mbt-asset-csv-apply-/u);
  expect(calls[1].body).toEqual({
    normalizedHash: NORMALIZED_HASH,
    targetRevisionToken: TARGET_REVISION_HASH,
    reason: "Approve synthetic opening inventory"
  });
});

test("P3-F11 CSV browser: async import controls preserve manual search focus and remain accessible on mobile", async ({
  page,
  request
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAssetApi(page);
  await openAssets(page, request);
  const search = page.locator("#assetSearch");
  await search.focus();
  await search.pressSequentially("P35CSV");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("P35CSV");

  await page.locator("#assetCsvFile").setInputFiles({
    name: file.fileName,
    mimeType: "text/csv",
    buffer: Buffer.from(file.content, "utf8")
  });
  await page.getByRole("button", { name: /preview.*server/i }).click();
  await expect(page.locator("#assetCsvPreviewRows")).toContainText(previewRows[0].assetCode);
  await search.focus();
  await search.pressSequentially("-FOCUS");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("P35CSV-FOCUS");

  const serious = await new AxeBuilder({ page }).analyze();
  expect(serious.violations.filter(({ impact }) => ["serious", "critical"].includes(impact || ""))).toEqual([]);
  const overflow = await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth
      - globalThis.document.documentElement.clientWidth
  ));
  expect(overflow).toBeLessThanOrEqual(1);
});
