import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const USERNAME = `mbt-p2-e2e-admin-${RUN_SUFFIX}`;
const PASSWORD = "mbt-test-phase-two-readiness-browser";
const RUN_ID = "60d4a24f-6c58-4ea0-a5f7-259a092e3201";
const HASH = "2".repeat(64);
const NEXT_HASH = "3".repeat(64);
const HOSTILE = `<img src=x onerror="window.__p2HostileExecuted=true">`;
const HOSTILE_MESSAGE = `Permission response ${HOSTILE} must remain plain text.`;
const SEMANTIC_HELP = "Required official REST evidence: legalName and currency.";
const RUNTIME_BINDING = Object.freeze({
  accountId: "P2_SB1",
  environmentName: "sandbox",
  restBaseUrl: "https://p2-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  directAccessEnabled: true,
  sandboxAccountAllowlist: Object.freeze(["P2_SB1"]),
  allowlistMatched: true,
  readTimeoutMs: 10_000,
  preflightLeaseSeconds: 120
});
const VERIFICATION_CONFIGURATION = Object.freeze({
  expected: { active: true, baseCurrency: "CAD" },
  caseInsensitiveFields: ["baseCurrency"]
});
const LOCAL_ITEMS = Object.freeze([
  {
    itemCode: "DELIVERY_CROSS_CHARGE",
    displayName: "Delivery Charge - MBT",
    description: "Calculated locally for SO, TO, PO, and VRMA cross-charges.",
    itemType: "delivery_fee",
    chargeBasis: "distance",
    rentalPeriodDays: null,
    category: "cross_charge",
    priceMode: "rate_card",
    applicableSourceTypes: ["SO", "TO", "PO", "VRMA"],
    binTypeCode: null,
    netSuiteMappingLocalKey: "delivery_charge",
    netSuite: null,
    futureNetSuiteStatus: "unconfigured",
    localReady: true,
    systemOwned: true,
    active: true,
    revision: 1
  },
  ...["14YD", "20YD", "40YD"].map((itemCode) => ({
    itemCode,
    displayName: `${itemCode.slice(0, -2)} yard bin charge`,
    description: "Fixed 14-day rental and extension price come from the approved local rate card.",
    itemType: "bin",
    chargeBasis: "rental_period",
    rentalPeriodDays: 14,
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: itemCode,
    netSuiteMappingLocalKey: `bin_${itemCode.toLowerCase()}`,
    netSuite: null,
    futureNetSuiteStatus: "unconfigured",
    localReady: true,
    systemOwned: true,
    active: true,
    revision: 1
  })),
  {
    itemCode: "DUMP",
    displayName: "Dump",
    description: "Customer dump charge is configured per tonne.",
    itemType: "dump",
    chargeBasis: "per_tonne",
    rentalPeriodDays: null,
    category: "dump",
    priceMode: "rate_card",
    applicableSourceTypes: [],
    binTypeCode: null,
    netSuiteMappingLocalKey: null,
    netSuite: null,
    futureNetSuiteStatus: "not_applicable",
    localReady: true,
    systemOwned: true,
    active: true,
    revision: 1
  }
]);

const MAPPING = Object.freeze({
  mappingId: "09350b56-3fc1-42bf-8410-519a7b550b45",
  mappingType: "subsidiary",
  localKey: "mbt",
  externalId: "33",
  externalScriptId: null,
  externalName: "MBT Sandbox Subsidiary",
  externalRecordType: "subsidiary",
  subsidiaryNetSuiteId: 33,
  configuration: VERIFICATION_CONFIGURATION,
  active: true,
  isCurrent: true,
  validationStatus: "valid",
  validationMessage: "Verified read-only.",
  revision: 1
});

const REQUIREMENT = Object.freeze({
  checkCode: "mbt_subsidiary",
  mappingType: "subsidiary",
  localKey: "mbt",
  expectedRecordType: "subsidiary",
  verificationKind: "active_subsidiary",
  required: true,
  requiredStatus: "verified",
  severity: "error",
  expected: { active: true, currency: "CAD" },
  display: {
    label: "MBT subsidiary",
    guidance: SEMANTIC_HELP
  },
  mapping: MAPPING
});

const RUN = Object.freeze({
  runId: RUN_ID,
  accountId: "P2_SB1",
  environmentName: "sandbox",
  configurationHash: HASH,
  status: "passed",
  generatedAt: "2026-08-03T14:00:00.000Z",
  ready: true,
  current: true,
  checks: [{
    sequenceNumber: 0,
    checkCode: "mbt_subsidiary",
    mappingType: "subsidiary",
    localKey: "mbt",
    required: true,
    severity: "error",
    status: "passed",
    expected: { active: true, currency: "CAD" },
    observed: { id: "33", active: true, currency: "CAD" },
    message: HOSTILE_MESSAGE
  }],
  signoff: null
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

async function installApiFixtures(page, calls) {
  await page.addInitScript(() => {
    globalThis.__p2HostileExecuted = false;
  });
  await page.route("**/api/mbt/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "mbt-v1",
        phase: 2,
        foundationEnabled: false,
        operational: false,
        capabilities: {
          frontdesk: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "mbt_disabled" },
          binDispatch: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "mbt_disabled" },
          driverBin: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "mbt_disabled" },
          billing: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "mbt_disabled" },
          netSuiteWrites: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "mbt_disabled" }
        }
      })
    });
  });
  await page.route("**/api/mbt/config/local/items**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ schemaVersion: "mbt-local-items-v1", items: LOCAL_ITEMS })
      });
      return;
    }
    const body = request.postDataJSON();
    const itemCode = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1));
    calls.push({ method: request.method(), path: new URL(request.url()).pathname, body });
    const original = LOCAL_ITEMS.find((item) => item.itemCode === itemCode);
    await route.fulfill({
      status: 200,
      headers: { "x-mbt-idempotent-replay": "false" },
      contentType: "application/json",
      body: JSON.stringify({
        item: { ...original, ...body, revision: original.revision + 1 }
      })
    });
  });
  await page.route("**/api/mbt/config/netsuite/mappings", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({
          phase: 2,
          configurationHash: HASH,
          runtime: RUNTIME_BINDING,
          requirements: [REQUIREMENT]
        })
      });
      return;
    }
    const body = route.request().postDataJSON();
    calls.push({ method, path: new URL(route.request().url()).pathname, body });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        phase: 2,
        configurationHash: NEXT_HASH,
        mapping: {
          ...MAPPING,
          ...body.mapping,
          revision: 2,
          validationStatus: "unverified",
          validationMessage: "Run the read-only preflight."
        }
      })
    });
  });
  await page.route("**/api/mbt/config/netsuite/preflight**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method === "GET" && path.endsWith("/latest")) {
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ phase: 2, run: RUN })
      });
      return;
    }
    if (method === "GET" && path.endsWith(`/${RUN_ID}`)) {
      await route.fulfill({
        status: 200,
        headers: { "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ phase: 2, run: RUN })
      });
      return;
    }
    const body = request.postDataJSON();
    calls.push({ method, path, body });
    if (path.endsWith("/signoff")) {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          signoff: {
            signoffId: "9585a5fe-78a1-472d-9b84-98dba17f606e",
            runId: RUN_ID,
            configurationHash: HASH,
            auditNote: body.auditNote,
            current: true,
            signedAt: "2026-08-03T14:05:00.000Z"
          }
        })
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ phase: 2, run: RUN })
    });
  });
}

async function openLocalConfiguration(page, request, calls) {
  await installApiFixtures(page, calls);
  const token = await tokenFor(request);
  await page.goto("/");
  await page.evaluate((value) => {
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "admin");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
  }, token);
  await page.goto("/mbt/config");
  await expect(page.getByRole("tab", { name: "Local Items" })).toHaveAttribute("aria-selected", "true");
}

async function openConfiguration(page, request, calls) {
  await openLocalConfiguration(page, request, calls);
  await page.getByRole("tab", { name: "Future NetSuite Setup" }).click();
  await expect(page.getByRole("tab", { name: "Future NetSuite Setup" })).toHaveAttribute("aria-selected", "true");
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "MBT Phase 2 browser Admin",
    password: PASSWORD,
    role: "admin",
    roles: ["admin"]
  });
});

test.afterAll(async () => {
  await removeFixture().catch(() => null);
});

test("LC08/LC09: local items render first without requesting NetSuite readiness", async ({ page, request }) => {
  const calls = [];
  const netSuiteRequests = [];
  page.on("request", (webRequest) => {
    if (new URL(webRequest.url()).pathname.includes("/api/mbt/config/netsuite/")) {
      netSuiteRequests.push(webRequest.url());
    }
  });
  await openLocalConfiguration(page, request, calls);

  const panel = page.getByRole("tabpanel", { name: "Local Items" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("row")).toHaveCount(6);
  await expect(panel.getByText("Delivery Charge - MBT", { exact: true })).toBeVisible();
  await expect(panel.getByRole("cell", { name: "Price per tonne", exact: true })).toBeVisible();
  await expect(panel.getByText("30YD", { exact: true })).toHaveCount(0);
  expect(netSuiteRequests).toEqual([]);
  expect(calls).toEqual([]);

  const accessibility = await new AxeBuilder({ page }).include("#localItemSettingsPanel").analyze();
  expect(accessibility.violations).toEqual([]);
});

test("LC05/LC08: local editor retains input focus and sends one bounded command", async ({ page, request }) => {
  const calls = [];
  await openLocalConfiguration(page, request, calls);
  const panel = page.getByRole("tabpanel", { name: "Local Items" });
  await panel.getByRole("button", { name: "Edit DUMP" }).click();
  const editor = panel.getByRole("region", { name: "Edit DUMP" });
  const displayName = editor.getByLabel("Display name");
  await displayName.fill("Local custom dump");
  await expect(displayName).toBeFocused();
  await editor.getByLabel("Description").fill("Custom price remains on the local order.");
  await editor.getByLabel("Audit reason").fill("Clarify local dump behavior");
  await editor.getByRole("button", { name: "Save local item" }).click();
  await expect(panel.getByRole("status")).toContainText("Local item saved");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    method: "PUT",
    path: "/api/mbt/config/local/items/DUMP",
    body: {
      displayName: "Local custom dump",
      description: "Custom price remains on the local order.",
      active: true,
      chargeBasis: "per_tonne",
      expectedRevision: 1,
      reason: "Clarify local dump behavior"
    }
  });
});

test("P2-F06: NetSuite Readiness is accessible, safely renders hostile text, and exposes reports", async ({ page, request }) => {
  const calls = [];
  await openConfiguration(page, request, calls);

  const panel = page.getByRole("tabpanel", { name: "Future NetSuite Setup" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "NetSuite Readiness" })).toBeVisible();
  await expect(panel.getByRole("table", { name: "NetSuite readiness mappings" })).toBeVisible();
  await expect(panel.getByText(HOSTILE_MESSAGE, { exact: true })).toBeVisible();
  await expect(panel.locator("img[src='x'], svg[onload], script")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__p2HostileExecuted)).toBe(false);

  const gates = panel.getByTestId("mbt-operational-gates");
  await expect(gates).toHaveAttribute("data-state", "closed");
  await expect(gates).toContainText("Closed");
  await expect(gates).toContainText("NetSuite writes");

  await expect(panel.getByRole("button", { name: "Run read-only preflight" })).toBeEnabled();
  await expect(panel.getByLabel("Signoff audit note")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Sign off current preflight" })).toBeEnabled();
  await expect(panel.getByRole("link", { name: "Export JSON" })).toHaveAttribute(
    "href",
    `/api/mbt/config/netsuite/preflight/${RUN_ID}/export?format=json`
  );
  await expect(panel.getByRole("link", { name: "Export CSV" })).toHaveAttribute(
    "href",
    `/api/mbt/config/netsuite/preflight/${RUN_ID}/export?format=csv`
  );

  const accessibility = await new AxeBuilder({ page }).include("[role='tabpanel']").analyze();
  expect(accessibility.violations).toEqual([]);
  expect(calls).toEqual([]);
});

test("P2-R6: Admin UI discloses the current sandbox runtime binding", async ({ page, request }) => {
  const calls = [];
  await openConfiguration(page, request, calls);
  const panel = page.getByRole("tabpanel", { name: "Future NetSuite Setup" });
  const runtime = panel.getByRole("region", { name: "Sandbox runtime binding" });

  await expect(runtime).toBeVisible();
  await expect(runtime).toContainText(RUNTIME_BINDING.accountId);
  await expect(runtime).toContainText(RUNTIME_BINDING.restBaseUrl);
  await expect(runtime).toContainText(/Direct access\s+Enabled/i);
  await expect(runtime).toContainText(/Allowlist\s+Matched/i);
  await expect(runtime).toContainText(/10,?000\s*ms/i);
  await expect(runtime).toContainText(/120\s*(?:s|seconds)/i);
  expect(calls).toEqual([]);
});

test("P2-R6: mapping editor renders server-owned semantic evidence help", async ({ page, request }) => {
  const calls = [];
  await openConfiguration(page, request, calls);
  const panel = page.getByRole("tabpanel", { name: "Future NetSuite Setup" });

  await panel.getByRole("button", { name: "Edit MBT subsidiary mapping" }).click();
  await expect(panel.getByText(SEMANTIC_HELP, { exact: true })).toBeVisible();
  expect(calls).toEqual([]);
});

test("P2-F02/F03/F04: accessible controls send revisioned mapping, preflight, and signoff commands", async ({ page, request }) => {
  const calls = [];
  await openConfiguration(page, request, calls);
  const panel = page.getByRole("tabpanel", { name: "Future NetSuite Setup" });

  await panel.getByRole("button", { name: "Edit MBT subsidiary mapping" }).click();
  await panel.getByLabel("NetSuite internal ID").fill("34");
  await panel.getByLabel("NetSuite display name").fill("Replacement sandbox subsidiary");
  await panel.getByLabel("Mapping audit reason").fill("Correct the approved sandbox mapping");
  await panel.getByRole("button", { name: "Save mapping" }).click();
  await expect(panel.getByRole("status")).toContainText("Mapping saved");

  await panel.getByRole("button", { name: "Run read-only preflight" }).click();
  await expect(panel.getByRole("status")).toContainText("Preflight passed");

  await panel.getByLabel("Signoff audit note").fill("Sandbox checklist verified by the test Admin");
  await panel.getByRole("button", { name: "Sign off current preflight" }).click();
  await expect(panel.getByRole("status")).toContainText("Preflight signed off");

  expect(calls).toHaveLength(3);
  expect(calls[0]).toMatchObject({
    method: "PUT",
    path: "/api/mbt/config/netsuite/mappings",
    body: {
      mappingType: "subsidiary",
      localKey: "mbt",
      expectedRevision: 1,
      reason: "Correct the approved sandbox mapping",
      mapping: {
        externalId: "34",
        externalName: "Replacement sandbox subsidiary"
      }
    }
  });
  expect(calls[1]).toEqual({
    method: "POST",
    path: "/api/mbt/config/netsuite/preflight",
    body: {}
  });
  expect(calls[2]).toEqual({
    method: "POST",
    path: `/api/mbt/config/netsuite/preflight/${RUN_ID}/signoff`,
    body: { auditNote: "Sandbox checklist verified by the test Admin" }
  });
});

test("P2-R4: verification configuration round-trips and invalid JSON never sends a mapping command", async ({ page, request }) => {
  const calls = [];
  await openConfiguration(page, request, calls);
  const panel = page.getByRole("tabpanel", { name: "Future NetSuite Setup" });

  await panel.getByRole("button", { name: "Edit MBT subsidiary mapping" }).click();
  const configuration = panel.getByLabel("Verification configuration (JSON)");
  await expect(configuration).toHaveValue(JSON.stringify(VERIFICATION_CONFIGURATION, null, 2));
  await panel.getByLabel("Mapping audit reason").fill("Update semantic verification evidence");

  await configuration.fill("{ invalid JSON");
  await panel.getByRole("button", { name: "Save mapping" }).click();
  await expect(panel.getByRole("status")).toContainText("valid JSON object");
  await expect(configuration).toHaveValue("{ invalid JSON");
  expect(calls).toEqual([]);

  await configuration.fill("[]");
  await panel.getByRole("button", { name: "Save mapping" }).click();
  await expect(panel.getByRole("status")).toContainText("JSON object");
  await expect(configuration).toHaveValue("[]");
  expect(calls).toEqual([]);

  const edited = {
    expected: { active: true, baseCurrency: "cad", subsidiaryId: "33" },
    caseInsensitiveFields: ["baseCurrency"]
  };
  await configuration.fill(JSON.stringify(edited));
  await panel.getByRole("button", { name: "Save mapping" }).click();
  await expect(panel.getByRole("status")).toContainText("Mapping saved");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: "PUT",
    path: "/api/mbt/config/netsuite/mappings",
    body: { mapping: { configuration: edited } }
  });
});
