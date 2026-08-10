import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const USERNAME = `p3-billing-e2e-${RUN_ID}`;
const PASSWORD = "p3-billing-synthetic-browser";
const CASE_ID = "00000000-0000-4000-8000-000000000251";
const VERSION_ID = "00000000-0000-4000-8000-000000000252";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000253";
const VISIT_ID = "00000000-0000-4000-8000-000000000254";
const DISTANCE_ID = "00000000-0000-4000-8000-000000000255";
const BATCH_ID = "00000000-0000-4000-8000-000000000256";
const ROW_ID = "00000000-0000-4000-8000-000000000257";
const CANDIDATE_ID = "eyJ2IjoxLCJraW5kIjoiZHJpdmVyIiwicGxhbklkIjpudWxsLCJsb2FkSWQiOiJMT0FELTEifQ";

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

async function openBilling(page, request) {
  const token = await tokenFor(request);
  await page.goto("/");
  await page.evaluate((value) => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "mbt_billing");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["mbt_billing"]));
  }, token);
  await page.goto("/mbt/billing");
}

function fulfillJson(route, status, body, extras = {}) {
  return route.fulfill({
    status,
    headers: { "cache-control": "no-store", ...extras },
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

function capturedCall(request) {
  return {
    method: request.method(),
    path: new URL(request.url()).pathname,
    body: request.postDataJSON(),
    idempotencyKey: request.headers()["idempotency-key"]
  };
}

function line() {
  return {
    billingLineId: "00000000-0000-4000-8000-000000000258",
    sequenceNumber: 0,
    lineKey: "transport",
    lineType: "transport",
    description: "Transport",
    quantity: "1.000000",
    unitOfMeasure: "TRIP",
    unitAmountMinor: 12500,
    netAmountMinor: 12500,
    estimatedTaxMinor: 1625,
    totalAmountMinor: 14125,
    currency: "CAD",
    localItemCode: "20YD",
    localItemRevision: 1,
    calculationDetail: {
      source: { type: "distance_snapshot", id: DISTANCE_ID }
    }
  };
}

function detail(browserState) {
  const versions = browserState.versionStatus ? [{
    billingVersionId: VERSION_ID,
    versionNumber: 1,
    status: browserState.versionStatus,
    postingMode: "local_only",
    subtotalMinor: 12500,
    estimatedTaxMinor: 1625,
    totalMinor: 14125,
    calculatedAt: "2038-08-03T12:00:00.000Z",
    approvedAt: browserState.versionStatus === "approved" ? "2038-08-03T12:05:00.000Z" : null,
    lines: [line()]
  }] : [];
  return {
    schemaVersion: "mbt-local-billing-case-v1",
    billingCaseId: CASE_ID,
    caseType: "mbt_contract",
    contractId: CONTRACT_ID,
    serviceVisitId: VISIT_ID,
    visitDistanceSnapshotId: DISTANCE_ID,
    crossChargeCaseId: null,
    customerNetsuiteId: "8600000000251",
    status: browserState.caseStatus,
    postingMode: "local_only",
    currentVersionNumber: versions.length,
    revision: browserState.revision,
    currency: "CAD",
    versions
  };
}

function queue(browserState) {
  return {
    schemaVersion: "mbt-local-billing-queue-v1",
    postingMode: "local_only",
    items: [{
      billingCaseId: CASE_ID,
      caseType: "mbt_contract",
      contractId: CONTRACT_ID,
      serviceVisitId: VISIT_ID,
      visitDistanceSnapshotId: DISTANCE_ID,
      crossChargeCaseId: null,
      customerNetsuiteId: "8600000000251",
      status: browserState.caseStatus,
      postingMode: "local_only",
      currency: "CAD",
      currentVersionNumber: browserState.versionStatus ? 1 : 0,
      revision: browserState.revision,
      billingVersionId: browserState.versionStatus ? VERSION_ID : null,
      versionStatus: browserState.versionStatus,
      totalMinor: browserState.versionStatus ? 14125 : null
    }],
    nextCursor: null
  };
}

function batch(browserState) {
  return {
    schemaVersion: "mbt-pilot-reconciliation-v1",
    batchId: BATCH_ID,
    batchReference: "MANUAL-PILOT-251",
    manualSource: "signed_driver_sheet",
    rows: [{
      reconciliationRowId: ROW_ID,
      comparisonKind: "distance",
      manualReference: "DISTANCE-251",
      comparisonResult: "open_variance",
      effectiveResult: browserState.varianceResolved ? "accepted_application" : "open_variance",
      differences: [{ field: "rawMetres" }],
      blocking: true,
      resolution: browserState.varianceResolved ? {
        resolutionId: "00000000-0000-4000-8000-000000000259",
        decision: "accepted_application"
      } : null
    }]
  };
}

async function installBillingApi(page, { commandsEnabled }) {
  const calls = [];
  const browserState = {
    caseStatus: "open",
    revision: 1,
    versionStatus: null,
    varianceResolved: false
  };
  const handlers = new Map([
    ["GET /api/mbt/status", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-v1",
      phase: 3,
      foundationEnabled: true,
      operational: commandsEnabled,
      capabilities: {
        billing: {
          enabled: commandsEnabled,
          code: commandsEnabled ? "MBT_CAPABILITY_ENABLED" : "MBT_CAPABILITY_DISABLED",
          reason: commandsEnabled ? "pilot_scope" : "capability_disabled"
        },
        netSuiteWrites: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "phase_3" }
      }
    })],
    ["GET /api/mbt/billing/status", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-billing-surface-v1",
      phase: 3,
      surface: "billing",
      enabled: commandsEnabled,
      commandState: {
        enabled: commandsEnabled,
        code: commandsEnabled ? null : "MBT_CAPABILITY_DISABLED",
        reason: commandsEnabled ? null : "capability_disabled"
      },
      postingMode: "local_only",
      netSuiteWritesEnabled: false,
      readOnlyRecoveryAvailable: true,
      message: commandsEnabled
        ? "Local shadow calculation, reconciliation, and approval are enabled."
        : "Billing commands are closed. Retained evidence remains available read-only."
    })],
    ["GET /api/mbt/billing/cases", async (route) => fulfillJson(route, 200, queue(browserState))],
    ["GET /api/mbt/billing/mbbs/candidates", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbbs-billing-candidates-v1",
      postingMode: "local_only_preview",
      rateCardVersionId: "00000000-0000-4000-8000-000000000260",
      currency: "CAD",
      items: [{
        candidateId: CANDIDATE_ID,
        sourceSystem: "driver_pwa",
        sourceRecordId: "unplanned:LOAD-1",
        physicalLoadId: "LOAD-1",
        planDate: "2038-08-03",
        completedAt: "2038-08-03T12:00:00.000Z",
        references: [{ sourceType: "SO", rootReference: "SOA01234" }],
        originYardCode: "2967",
        originLabel: "2967 Kennedy Road",
        destinationLabel: "100 Queen Street West",
        routeStopCount: 2,
        chargeable: true,
        reason: null
      }]
    })],
    [`POST /api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/preview`, async (route) => {
      calls.push(capturedCall(route.request()));
      await fulfillJson(route, 200, {
        schemaVersion: "mbbs-billing-candidate-preview-v1",
        postingMode: "local_only_preview",
        externalWork: null,
        distanceMetres: 31_000,
        selectedBand: {
          minimumMetres: 30_000,
          maximumMetres: 50_000,
          pricingBasis: "flat"
        },
        charge: {
          itemCode: "DELIVERY_CHARGE_MBBS",
          amountMinor: 25_000,
          currency: "CAD",
          estimatedTaxMinor: 0,
          totalMinor: 25_000
        }
      });
    }],
    [`GET /api/mbt/billing/cases/${CASE_ID}`, async (route) => fulfillJson(route, 200, detail(browserState))],
    [`POST /api/mbt/billing/cases/${CASE_ID}/calculate`, async (route) => {
      calls.push(capturedCall(route.request()));
      browserState.caseStatus = "ready";
      browserState.revision = 2;
      browserState.versionStatus = "draft";
      await fulfillJson(route, 201, {
        schemaVersion: "mbt-local-billing-draft-v1",
        billingCaseId: CASE_ID,
        billingVersionId: VERSION_ID,
        versionNumber: 1,
        status: "draft",
        postingMode: "local_only"
      }, { "x-mbt-idempotent-replay": "false" });
    }],
    [`POST /api/mbt/billing/cases/${CASE_ID}/approve-local`, async (route) => {
      calls.push(capturedCall(route.request()));
      browserState.caseStatus = "approved";
      browserState.revision = 3;
      browserState.versionStatus = "approved";
      await fulfillJson(route, 200, {
        schemaVersion: "mbt-local-billing-approval-v1",
        billingCaseId: CASE_ID,
        billingVersionId: VERSION_ID,
        versionNumber: 1,
        status: "approved",
        postingMode: "local_only"
      }, { "x-mbt-idempotent-replay": "false" });
    }],
    ["GET /api/mbt/reconciliation/batches", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-pilot-reconciliation-list-v1",
      items: [{
        batchId: BATCH_ID,
        batchReference: "MANUAL-PILOT-251",
        manualSource: "signed_driver_sheet",
        rowCount: 1,
        openVarianceCount: browserState.varianceResolved ? 0 : 1
      }],
      nextCursor: null
    })],
    [`GET /api/mbt/reconciliation/batches/${BATCH_ID}`, async (route) => fulfillJson(
      route,
      200,
      batch(browserState)
    )],
    [`POST /api/mbt/reconciliation/batches/${BATCH_ID}/resolve`, async (route) => {
      calls.push(capturedCall(route.request()));
      browserState.varianceResolved = true;
      await fulfillJson(route, 201, {
        schemaVersion: "mbt-pilot-reconciliation-resolution-v1",
        reconciliationRowId: ROW_ID,
        decision: "accepted_application"
      }, { "x-mbt-idempotent-replay": "false" });
    }]
  ]);
  await page.route("**/api/mbt/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const key = `${request.method()} ${path}`;
    const handler = handlers.get(key);
    if (handler) {
      await handler(route);
      return;
    }
    await fulfillJson(route, 404, {
      error: `Unmocked synthetic Billing route: ${key}`,
      code: "MBT_TEST_ROUTE_UNMOCKED"
    });
  });
  return { calls, browserState };
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "Synthetic P3 Billing",
    password: PASSWORD,
    role: "mbt_billing",
    roles: ["mbt_billing"]
  });
});

test.afterAll(async () => {
  await removeFixture().catch(() => null);
});

test("P3-F23–P3-F28 browser: bound visit calculation, local approval, and variance review create no posting work", async ({ page, request }) => {
  const { calls } = await installBillingApi(page, { commandsEnabled: true });
  await openBilling(page, request);
  await expect(page.getByRole("heading", { name: "Reconcile, calculate, approve locally" })).toBeVisible();
  await expect(page.getByText("No outbox or NetSuite transport")).toBeVisible();
  await expect(page.getByRole("cell", { name: "MBT contract" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "SO SOA01234" })).toBeVisible();
  await page.getByRole("button", { name: "Calculate charge" }).click();
  await expect(page.locator("#mbbsCandidatePreview")).toContainText("DELIVERY_CHARGE_MBBS · $250.00");

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByLabel("Service visit UUID")).toHaveValue(VISIT_ID);
  await expect(page.getByLabel("Distance snapshot UUID")).toHaveValue(DISTANCE_ID);
  const calculateForm = page.locator("#calculateBillingForm");
  await calculateForm.getByLabel("Audit reason").fill("Synthetic browser calculation");
  await calculateForm.getByRole("button", { name: "Calculate complete local draft" }).click();
  await expect(page.getByRole("cell", { name: "Version 1 · draft" })).toBeVisible();
  await expect(page.getByLabel("Scrollable billing version lines")
    .getByRole("cell", { name: "$141.25", exact: true }).first()).toBeVisible();

  const approvalForm = page.locator("#approveBillingForm");
  await expect(approvalForm.getByLabel("Billing version UUID")).toHaveValue(VERSION_ID);
  await approvalForm.getByLabel("Audit reason").fill("Synthetic local approval");
  await approvalForm.getByRole("button", { name: "Approve locally" }).click();
  await expect(page.getByRole("cell", { name: "Version 1 · approved" })).toBeVisible();

  await page.getByRole("button", { name: "Review evidence" }).click();
  await expect(page.getByRole("cell", { name: "rawMetres" })).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  const resolveForm = page.locator("#resolveVarianceForm");
  await resolveForm.getByLabel("Audit note").fill("Server distance evidence accepted for the pilot");
  await resolveForm.getByRole("button", { name: "Record immutable decision" }).click();
  await expect(page.getByRole("cell", { name: "accepted_application" }).first()).toBeVisible();

  expect(calls.map(({ path }) => path)).toEqual([
    `/api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/preview`,
    `/api/mbt/billing/cases/${CASE_ID}/calculate`,
    `/api/mbt/billing/cases/${CASE_ID}/approve-local`,
    `/api/mbt/reconciliation/batches/${BATCH_ID}/resolve`
  ]);
  expect(calls[1].body.serviceVisitId).toBe(VISIT_ID);
  expect(calls[1].body.distanceSnapshotId).toBe(DISTANCE_ID);
  expect(calls[2].body.billingVersionId).toBe(VERSION_ID);
  expect(calls[3].body.reconciliationRowId).toBe(ROW_ID);
  expect(calls.slice(1).every(({ idempotencyKey }) => typeof idempotencyKey === "string" && idempotencyKey.length > 0)).toBe(true);
  expect(calls.some(({ path }) => /netsuite|sales.?order|deposit|outbox|\/post/iu.test(path))).toBe(false);

  const accessibility = await new AxeBuilder({ page })
    .include("#mbtApp")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations.filter(({ impact }) => ["critical", "serious"].includes(impact))).toEqual([]);
  expect(await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
  ))).toBe(true);
});

test("P3-F27 browser: closing billing commands keeps queue/detail review visible and disables every mutation", async ({ page, request }) => {
  const { calls } = await installBillingApi(page, { commandsEnabled: false });
  await openBilling(page, request);
  await expect(page.getByText(/Commands are closed; retained evidence is available read-only/u)).toBeVisible();
  await expect(page.getByRole("cell", { name: "MBT contract" })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByLabel("Service visit UUID")).toHaveValue(VISIT_ID);
  await page.getByRole("button", { name: "Review evidence" }).click();
  await expect(page.getByRole("cell", { name: "rawMetres" })).toBeVisible();
  const commands = page.locator(".mbt-command");
  await expect(commands).toHaveCount(7);
  for (let index = 0; index < await commands.count(); index += 1) {
    await expect(commands.nth(index)).toBeDisabled();
  }
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
  ))).toBe(true);
});
