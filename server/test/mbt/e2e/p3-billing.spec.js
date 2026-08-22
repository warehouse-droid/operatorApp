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
const CANDIDATE_ID_2 = "eyJ2IjoxLCJraW5kIjoic2FsZXNfb3JkZXIiLCJuZXRzdWl0ZUlkIjoiMiJ9";
const RATE_VERSION_ID = "00000000-0000-4000-8000-000000000260";
const BILLING_CUSTOMER_ID = "8600000000251";

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

function batchPreviewResults() {
  return [{
    candidateId: CANDIDATE_ID,
    status: "calculated",
    candidate: {
      references: [{ sourceType: "PO", rootReference: "PO55174" }],
      billingRule: "po_shared_leg",
      billingLegId: "PO-LEG-1",
      billingLegNumber: 1,
      driverLoadNumbers: ["Load 1"],
      originLabel: "2967 Kennedy Road",
      destinationLabel: "100 Queen Street West",
      relationship: { summary: "One Purchase Order uses one retained business leg." },
      vendorRouteEvidence: {
        localVendorName: "BWS",
        vendorYardName: "BWS Uxbridge",
        mbbsYardCode: "12441",
        endpointOverride: true
      }
    },
    rateCardVersionId: RATE_VERSION_ID,
    rateCardVersionNumber: 1,
    distanceMetres: 31_000,
    distanceAvailable: true,
    automaticRate: { available: true, code: null, message: null },
    selectedBand: {
      minimumMetres: 30_000,
      maximumMetres: 50_000,
      pricingBasis: "flat"
    },
    pricingMethod: "vendor_yard_flat",
    pricingOptions: [{
      pricingMethod: "vendor_yard_flat",
      label: "Configured vendor-yard flat rate",
      available: true
    }, {
      pricingMethod: "distance_band",
      label: "Normal distance-band rate",
      available: true
    }],
    selectedVendorRouteRate: {
      displayName: "Bestway Stone - Uxbridge to 12441",
      vendorYardName: "BWS Uxbridge",
      destinationYardCode: "12441",
      baseAmountMinor: 25_000
    },
    calculationSteps: [{
      stepNumber: 1,
      code: "vendor_yard_flat_rate",
      description: "Bestway Stone - Uxbridge to 12441 configured pair",
      amountMinor: 25_000
    }],
    charge: {
      itemCode: "DELIVERY_CHARGE_MBBS",
      calculatedAmountMinor: 25_000,
      adjustmentMinor: 0,
      finalAmountMinor: 25_000,
      amountMinor: 25_000,
      currency: "CAD",
      estimatedTaxMinor: 0,
      totalMinor: 25_000
    }
  }, {
    candidateId: CANDIDATE_ID_2,
    status: "manual_required",
    candidate: {
      references: [{ sourceType: "SO", rootReference: "SOA05678" }],
      billingRule: "so_order",
      billingLegId: "SO-LEG-2",
      billingLegNumber: 2,
      driverLoadNumbers: ["Load 2"],
      originLabel: "2967 Kennedy Road",
      destinationLabel: "200 King Street West",
      relationship: { summary: "Sales Order charged independently, once for the order." }
    },
    rateCardVersionId: RATE_VERSION_ID,
    rateCardVersionNumber: 1,
    distanceMetres: 0,
    distanceAvailable: false,
    automaticRate: {
      available: false,
      code: "MBT_MBBS_DISTANCE_LOOKUP_FAILED",
      message: "No supported driving route was found."
    },
    selectedBand: null,
    charge: {
      itemCode: "DELIVERY_CHARGE_MBBS",
      calculatedAmountMinor: 0,
      adjustmentMinor: 0,
      finalAmountMinor: 0,
      amountMinor: 0,
      currency: "CAD",
      estimatedTaxMinor: 0,
      totalMinor: 0
    }
  }];
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
      schemaVersion: "mbbs-billing-candidates-v2",
      postingMode: "local_only_preview",
      completedMonth: null,
      completedDate: null,
      rateOptions: [{
        rateCardVersionId: RATE_VERSION_ID,
        rateCardCode: "DELIVERY_CHARGE_MBBS",
        displayName: "Standard MBBS delivery",
        versionNumber: 1,
        currency: "CAD"
      }],
      items: [{
        candidateId: CANDIDATE_ID,
        sourceSystem: "driver_pwa",
        sourceRecordId: "unplanned:LOAD-1",
        physicalLoadId: "LOAD-1",
        planDate: "2038-08-03",
        completedAt: "2038-08-03T12:00:00.000Z",
        references: [{ sourceType: "PO", rootReference: "PO55174" }],
        originYardCode: "2967",
        originLabel: "2967 Kennedy Road",
        destinationLabel: "100 Queen Street West",
        routeStopCount: 2,
        chargeable: true,
        reason: null
      }, {
        candidateId: CANDIDATE_ID_2,
        sourceSystem: "sales_order",
        sourceRecordId: "2",
        physicalLoadId: "SO-2",
        planDate: "2038-08-03",
        completedAt: "2038-08-03T13:00:00.000Z",
        references: [{ sourceType: "SO", rootReference: "SOA05678" }],
        originYardCode: "2967",
        originLabel: "2967 Kennedy Road",
        destinationLabel: "200 King Street West",
        routeStopCount: 2,
        chargeable: true,
        reason: null
      }]
    })],
    ["GET /api/mbt/billing/mbbs/customers", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbbs-billing-customer-search-v1",
      search: "Synthetic",
      items: [{
        netsuiteId: BILLING_CUSTOMER_ID,
        entityNumber: "SYNTHETIC-MBBS",
        legalName: "Synthetic MBBS Billing Customer",
        displayName: "Synthetic MBBS Billing Customer",
        currency: "CAD"
      }]
    })],
    [`POST /api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/preview`, async (route) => {
      calls.push(capturedCall(route.request()));
      await fulfillJson(route, 200, {
        schemaVersion: "mbbs-billing-candidate-preview-v1",
        postingMode: "local_only_preview",
        externalWork: null,
        candidate: {
          references: [{ sourceType: "PO", rootReference: "PO55174" }],
          billingRule: "po_shared_leg",
          billingLegId: "PO-LEG-1",
          billingLegNumber: 1,
          driverLoadNumbers: ["Load 1"],
          originLabel: "65 Anderson Blvd, Uxbridge, ON",
          destinationLabel: "12441 Woodbine Avenue",
          relationship: { summary: "One Purchase Order uses one retained business leg." },
          vendorRouteEvidence: {
            localVendorName: "BWS",
            vendorYardName: "BWS Uxbridge",
            mbbsYardCode: "12441",
            endpointOverride: true
          }
        },
        distanceMetres: 31_000,
        distanceAvailable: true,
        automaticRate: { available: true, code: null, message: null },
        pricingMethod: "distance_band",
        pricingOptions: [{
          pricingMethod: "vendor_yard_flat",
          label: "Configured vendor-yard flat rate",
          available: true
        }, {
          pricingMethod: "distance_band",
          label: "Normal distance-band rate",
          available: true
        }],
        selectedVendorRouteRate: {
          displayName: "Bestway Stone - Uxbridge to 12441",
          vendorYardName: "BWS Uxbridge",
          destinationYardCode: "12441",
          baseAmountMinor: 25_000
        },
        selectedBand: {
          minimumMetres: 30_000,
          maximumMetres: 50_000,
          pricingBasis: "flat"
        },
        charge: {
          itemCode: "DELIVERY_CHARGE_MBBS",
          calculatedAmountMinor: 20_000,
          adjustmentMinor: 0,
          finalAmountMinor: 20_000,
          amountMinor: 20_000,
          currency: "CAD",
          estimatedTaxMinor: 0,
          totalMinor: 20_000
        },
        calculationSteps: [{
          stepNumber: 1,
          code: "distance_rate",
          description: "Distance-band charge for 31.0 km",
          amountMinor: 20_000
        }]
      });
    }],
    ["POST /api/mbt/billing/mbbs/candidates/batch-preview", async (route) => {
      calls.push(capturedCall(route.request()));
      await fulfillJson(route, 200, {
        schemaVersion: "mbbs-billing-candidate-batch-preview-v1",
        postingMode: "local_only_preview",
        externalWork: null,
        completedMonth: "2038-08",
        rateCardVersionId: RATE_VERSION_ID,
        requestedCount: 2,
        successCount: 2,
        failureCount: 0,
        manualRequiredCount: 1,
        results: batchPreviewResults()
      });
    }],
    ["POST /api/mbt/billing/mbbs/candidates/batch-create", async (route) => {
      calls.push(capturedCall(route.request()));
      await fulfillJson(route, 201, {
        schemaVersion: "mbbs-billing-candidate-batch-create-v1",
        generationId: "00000000-0000-4000-8000-000000000261",
        requestedCandidateCount: 1,
        durableCaseCount: 1,
        postingMode: "local_only",
        externalWork: null,
        cases: []
      }, { "x-mbt-idempotent-replay": "false" });
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

test("billing browser batches selected monthly candidates and switches to billing-case master/detail without posting", async ({ page, request }) => {
  const { calls } = await installBillingApi(page, { commandsEnabled: true });
  await openBilling(page, request);
  await expect(page.getByRole("heading", { name: "MBT Billing" })).toBeVisible();
  await expect(page.getByText("No outbox or NetSuite transport")).toBeVisible();
  await expect(page.getByRole("cell", { name: "PO PO55174", exact: true })).toBeVisible();
  await page.getByLabel("Completed date (Toronto, optional)").fill("2038-08-03");
  await page.getByLabel("Completed date (Toronto, optional)").press("Tab");
  await expect(page.getByLabel("Completed month (Toronto)")).toHaveValue("2038-08");
  await page.getByLabel("Choose MBBS rate card").selectOption(RATE_VERSION_ID);
  await page.getByLabel("Select all ready MBBS candidates").check();
  await page.getByRole("button", { name: "Calculate selected orders" }).click();
  await expect(page.locator("#mbbsBatchResultRows")).toContainText("PO PO55174");
  await expect(page.locator("#mbbsBatchResultRows")).toContainText("$250.00");
  await expect(page.locator("#mbbsBatchResultRows")).toContainText("31 km");
  await expect(page.locator("#mbbsBatchResultRows")).toContainText("Bestway Stone - Uxbridge to 12441");
  await expect(page.locator("#mbbsBatchResultRows")).toContainText("No automatic rate");
  await page.getByLabel("Pricing method for PO PO55174").selectOption("distance_band");
  await expect(page.locator("#mbbsCandidateMessage")).toContainText("Normal distance-band rate selected");
  await page.getByLabel("Signed adjustment for PO PO55174").fill("-10.00");
  await expect(page.getByLabel("Final charge for PO PO55174")).toHaveValue("190.00");
  await page.getByLabel("Final charge for SO SOA05678").fill("260.00");
  await expect(page.getByLabel("Signed adjustment for SO SOA05678")).toHaveValue("260.00");
  await expect(page.getByLabel("Convert PO PO55174 to billing")).toBeChecked();
  await expect(page.getByLabel("Convert SO SOA05678 to billing")).not.toBeChecked();
  await page.getByLabel("Convert SO SOA05678 to billing").check();
  await page.getByLabel("Find canonical billing customer").fill("Synthetic");
  await page.getByRole("button", { name: "Search customers" }).click();
  await expect(page.getByLabel("Selected billing customer")).toHaveValue(BILLING_CUSTOMER_ID);
  await page.getByLabel("Conversion audit reason").fill("Create verified local MBBS billing cases");
  await page.getByRole("button", { name: "Create local billing cases" }).click();
  await expect(page.locator("#mbbsCandidateMessage")).toContainText("1 local billing case(s) created");

  await page.getByRole("tab", { name: "Billing cases" }).click();
  await expect(page.getByRole("cell", { name: "MBT contract" })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("#billingCaseDetail")).toContainText("MBT contract · open · revision 1");
  await expect(page.locator("#billingCaseDetail")).toContainText("No calculated version exists yet");
  await page.getByLabel("Waiver amount (CAD)").fill("10.00");
  await page.getByLabel("Waiver audit note").fill("Customer service recovery");
  await page.getByLabel("Calculation audit reason").fill("Calculate selected completed visit");
  await page.getByRole("button", { name: "Calculate selected case" }).click();
  await expect(page.locator("#billingCaseDetail")).toContainText("Version 1 · draft");
  await page.getByLabel("Approval audit reason").fill("Billing evidence reviewed");
  await page.getByRole("button", { name: "Approve selected draft locally" }).click();
  await expect(page.locator("#billingCaseDetail")).toContainText("MBT contract · approved · revision 3");
  await expect(page.getByText("Calculation evidence and versions")).toHaveCount(0);
  await expect(page.getByText("Pilot reconciliation")).toHaveCount(0);

  expect(calls.map(({ path }) => path)).toEqual([
    "/api/mbt/billing/mbbs/candidates/batch-preview",
    `/api/mbt/billing/mbbs/candidates/${CANDIDATE_ID}/preview`,
    "/api/mbt/billing/mbbs/candidates/batch-create",
    `/api/mbt/billing/cases/${CASE_ID}/calculate`,
    `/api/mbt/billing/cases/${CASE_ID}/approve-local`
  ]);
  expect(calls[0].body).toEqual({
    candidateIds: [CANDIDATE_ID, CANDIDATE_ID_2],
    completedMonth: "2038-08",
    completedDate: "2038-08-03",
    rateCardVersionId: RATE_VERSION_ID
  });
  expect(calls[1].body).toEqual({
    completedMonth: "2038-08",
    completedDate: "2038-08-03",
    rateCardVersionId: RATE_VERSION_ID,
    pricingMethod: "distance_band"
  });
  expect(calls[2].body).toEqual({
    candidateIds: [CANDIDATE_ID, CANDIDATE_ID_2],
    completedMonth: "2038-08",
    completedDate: "2038-08-03",
    rateCardVersionId: RATE_VERSION_ID,
    customerNetsuiteId: BILLING_CUSTOMER_ID,
    manualAmountEdits: [{
      candidateId: CANDIDATE_ID,
      calculatedAmountMinor: 20_000,
      adjustmentMinor: -1_000,
      finalAmountMinor: 19_000
    }, {
      candidateId: CANDIDATE_ID_2,
      calculatedAmountMinor: 0,
      adjustmentMinor: 26_000,
      finalAmountMinor: 26_000
    }],
    pricingSelections: [{
      candidateId: CANDIDATE_ID,
      pricingMethod: "distance_band"
    }],
    reason: "Create verified local MBBS billing cases"
  });
  expect(calls[2].idempotencyKey).toMatch(/^mbt-billing-batch-create:/u);
  expect(calls[3].body).toEqual({
    serviceVisitId: VISIT_ID,
    distanceSnapshotId: DISTANCE_ID,
    expectedRevision: 1,
    componentQuantities: {},
    customPrices: [],
    waiver: {
      amountMinor: 1000,
      reason: "Customer service recovery",
      description: "Audited billing waiver",
      taxable: false
    },
    reason: "Calculate selected completed visit"
  });
  expect(calls[4].body).toEqual({
    billingVersionId: VERSION_ID,
    expectedRevision: 2,
    reason: "Billing evidence reviewed"
  });
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
  await page.getByRole("tab", { name: "Billing cases" }).click();
  await expect(page.getByRole("cell", { name: "MBT contract" })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator("#billingCaseDetail")).toContainText("MBT contract · open · revision 1");
  await page.getByRole("tab", { name: "Order candidates" }).click();
  const commands = page.locator(".mbt-command");
  await expect(commands).toHaveCount(5);
  for (let index = 0; index < await commands.count(); index += 1) {
    await expect(commands.nth(index)).toBeDisabled();
  }
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
  ))).toBe(true);
});
