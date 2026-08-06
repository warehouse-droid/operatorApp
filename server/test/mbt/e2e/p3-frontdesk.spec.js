import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const USERNAME = `p3-frontdesk-e2e-${RUN_ID}`;
const PASSWORD = "p3-frontdesk-synthetic-browser";
const CUSTOMER_ID = "8600000000137";
const SITE_ID = "00000000-0000-4000-8000-000000000137";
const ADDRESS_ID = "00000000-0000-4000-8000-000000000138";
const TEMPLATE_VERSION_ID = "00000000-0000-4000-8000-000000000139";
const RATE_VERSION_ID = "00000000-0000-4000-8000-000000000140";
const BIN_TYPE_ID = "00000000-0000-4000-8000-000000000014";
const QUOTE_ID = "00000000-0000-4000-8000-000000000141";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000142";
const DELIVERY_VISIT_ID = "00000000-0000-4000-8000-000000000143";
const RETURN_VISIT_ID = "00000000-0000-4000-8000-000000000144";
const BILLING_CASE_ID = "00000000-0000-4000-8000-000000000145";

const CUSTOMER = Object.freeze({
  customerNetsuiteId: CUSTOMER_ID,
  entityNumber: "SYN137",
  displayName: "Synthetic Pilot Customer",
  currency: "CAD",
  serviceReady: true,
  sites: [{
    siteProfileId: SITE_ID,
    addressId: ADDRESS_ID,
    label: "Synthetic service site",
    addressLine1: "100 Test Route",
    city: "Toronto",
    region: "ON",
    postalCode: "M1M 1M1",
    active: true,
    revision: 1
  }]
});

const PRICING = Object.freeze({
  currency: "CAD",
  distanceMetres: 12_500,
  subtotalMinor: 47_500,
  taxMinor: 6_175,
  totalMinor: 53_675,
  lines: [
    { code: "bin_base_rental", label: "14-day rental", amountMinor: 35_000 },
    { code: "estimated_dump_weight", label: "Garbage · 1.000 t estimated", amountMinor: 0 },
    { code: "one_way_delivery", label: "One-way delivery", amountMinor: 12_500 }
  ]
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

async function openFrontdesk(page, request) {
  const token = await tokenFor(request);
  await page.goto("/");
  await page.evaluate((value) => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "mbt_frontdesk");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["mbt_frontdesk"]));
  }, token);
  await page.goto("/mbt/frontdesk");
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

function quote(status, revision, additions = {}) {
  return {
    quoteId: QUOTE_ID,
    quoteNumber: "MBT-Q-SYN-0137",
    customerNetsuiteId: CUSTOMER_ID,
    siteProfileId: SITE_ID,
    serviceTemplateVersionId: TEMPLATE_VERSION_ID,
    rateCardVersionId: RATE_VERSION_ID,
    binTypeId: BIN_TYPE_ID,
    binTypeCode: "14YD",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z",
    status,
    revision,
    pricing: PRICING,
    depositRequiredMinor: 10_000,
    ...additions
  };
}

function conversion() {
  return {
    schemaVersion: "mbt-frontdesk-conversion-v1",
    contract: {
      contractId: CONTRACT_ID,
      contractNumber: "MBT-C-SYN-0137",
      quoteId: QUOTE_ID,
      status: "confirmed",
      revision: 1,
      customer: CUSTOMER,
      pricing: PRICING
    },
    visits: [
      {
        visitId: DELIVERY_VISIT_ID,
        visitNumber: 1,
        serviceAction: "delivery",
        displayName: "Initial delivery",
        status: "ready",
        predecessorVisitId: null,
        scheduledStartAt: "2037-08-03T12:00:00.000Z",
        scheduledEndAt: "2037-08-03T16:00:00.000Z"
      },
      {
        visitId: RETURN_VISIT_ID,
        visitNumber: 2,
        serviceAction: "return_bin",
        displayName: "Return bin",
        status: "tentative",
        predecessorVisitId: DELIVERY_VISIT_ID,
        scheduledStartAt: "2037-08-17T12:00:00.000Z",
        scheduledEndAt: "2037-08-17T16:00:00.000Z"
      }
    ],
    billingCase: {
      billingCaseId: BILLING_CASE_ID,
      caseType: "mbt_contract",
      status: "open"
    }
  };
}

async function installFrontdeskApi(page) {
  const calls = [];
  const state = { currentQuote: null, converted: null };
  await page.route("**/api/mbt/status", async (route) => {
    await fulfillJson(route, 200, {
      schemaVersion: "mbt-v1",
      phase: 3,
      foundationEnabled: true,
      operational: true,
      capabilities: {
        frontdesk: { enabled: true, code: "MBT_CAPABILITY_ENABLED", reason: "pilot_scope" },
        netSuiteWrites: { enabled: false, code: "MBT_CAPABILITY_DISABLED", reason: "phase_3" }
      }
    });
  });
  const handlers = new Map([
    ["GET /api/mbt/frontdesk/status", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-frontdesk-status-v1",
      phase: 3,
      surface: "frontdesk",
      enabled: true,
      postingEnabled: false
    })],
    ["GET /api/mbt/frontdesk/configuration", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-frontdesk-configuration-v1",
      binItems: [{ itemCode: "14YD", binTypeId: BIN_TYPE_ID, typeCode: "14YD", displayName: "14 yard" }],
      binTypes: [{ itemCode: "14YD", binTypeId: BIN_TYPE_ID, typeCode: "14YD", displayName: "14 yard" }],
      deliveryItems: [{ itemCode: "DELIVERY_CROSS_CHARGE", displayName: "Delivery Charge - MBT" }],
      dumpItems: [{ itemCode: "DUMP", displayName: "Garbage" }],
      surchargeItems: [{ itemCode: "DOWNTOWN", displayName: "Downtown surcharge" }],
      services: [{
        serviceCode: "delivery",
        displayName: "Initial delivery",
        templateVersionId: TEMPLATE_VERSION_ID,
        rateCardVersionId: RATE_VERSION_ID,
        defaultRentalCalendarDays: 14
      }]
    })],
    ["GET /api/mbt/frontdesk/customers", async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-frontdesk-customers-v1",
      items: new URL(route.request().url()).searchParams.get("query") ? [CUSTOMER] : []
    })],
    [`GET /api/mbt/frontdesk/customers/${CUSTOMER_ID}/contracts`, async (route) => fulfillJson(route, 200, {
      schemaVersion: "mbt-frontdesk-customer-contracts-v1",
      customerNetsuiteId: CUSTOMER_ID,
      items: state.converted ? [{
        ...state.converted.contract,
        serviceLineCount: 1,
        openServiceLineCount: 1
      }] : []
    })],
    ["POST /api/mbt/frontdesk/quotes", async (route) => {
      calls.push(capturedCall(route.request()));
      state.currentQuote = quote("draft", 1);
      await fulfillJson(route, 201, {
        schemaVersion: "mbt-frontdesk-quote-v1",
        quote: state.currentQuote
      }, { "x-mbt-idempotent-replay": "false" });
    }],
    [`POST /api/mbt/frontdesk/quotes/${QUOTE_ID}/issue`, async (route) => {
      const captured = capturedCall(route.request());
      calls.push(captured);
      state.currentQuote = quote("issued", 2, { validUntil: captured.body.validUntil });
      await fulfillJson(route, 200, {
        schemaVersion: "mbt-frontdesk-quote-v1",
        quote: state.currentQuote
      });
    }],
    [`POST /api/mbt/frontdesk/quotes/${QUOTE_ID}/accept`, async (route) => {
      calls.push(capturedCall(route.request()));
      state.currentQuote = quote("accepted", 3, {
        acceptedAt: "2037-08-03T10:00:00.000Z"
      });
      await fulfillJson(route, 200, {
        schemaVersion: "mbt-frontdesk-quote-v1",
        quote: state.currentQuote
      });
    }],
    [`POST /api/mbt/frontdesk/quotes/${QUOTE_ID}/convert`, async (route) => {
      calls.push(capturedCall(route.request()));
      state.converted = conversion();
      await fulfillJson(route, 201, state.converted, {
        "x-mbt-idempotent-replay": "false"
      });
    }],
    [`GET /api/mbt/frontdesk/contracts/${CONTRACT_ID}`, async (route) => fulfillJson(
      route,
      200,
      {
        schemaVersion: "mbt-frontdesk-contract-v1",
        contract: state.converted?.contract,
        visits: state.converted?.visits || []
      }
    )],
    [`POST /api/mbt/frontdesk/contracts/${CONTRACT_ID}/extensions`, async (route) => {
      const captured = capturedCall(route.request());
      calls.push(captured);
      const prior = conversion();
      const amendedReturn = {
        ...prior.visits[1],
        revision: 2,
        scheduledStartAt: captured.body.returnWindow.startAt,
        scheduledEndAt: captured.body.returnWindow.endAt
      };
      state.converted = {
        ...prior,
        contract: { ...prior.contract, revision: 2 },
        visits: [prior.visits[0], amendedReturn]
      };
      await fulfillJson(route, 200, {
        schemaVersion: "mbt-frontdesk-extension-v1",
        contract: state.converted.contract,
        amendment: {
          amendmentId: "00000000-0000-4000-8000-000000000146",
          amendmentNumber: 1,
          amendmentType: "extension",
          status: "approved"
        },
        returnVisit: amendedReturn
      });
    }]
  ]);
  await page.route("**/api/mbt/frontdesk/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const handler = handlers.get(`${request.method()} ${path}`);
    if (handler) {
      await handler(route);
      return;
    }
    await fulfillJson(route, 404, {
      error: `Unmocked synthetic Front Desk route: ${request.method()} ${path}`,
      code: "MBT_TEST_ROUTE_UNMOCKED"
    });
  });
  return calls;
}

async function completeSyntheticConversion(page) {
  const search = page.getByRole("combobox", { name: "Search customers" });
  await search.fill("Synthetic Pilot");
  const customer = page.getByRole("option", { name: /Synthetic Pilot Customer/ });
  await expect(customer).toBeVisible();
  await expect(search).toBeFocused();
  await customer.click();
  await page.getByRole("button", { name: "Add new order" }).click();
  await expect(page.getByRole("dialog", { name: "Choose the work type" })).toBeVisible();
  await page.getByRole("combobox", { name: "Order type" }).selectOption("bin");
  await page.getByRole("combobox", { name: "BIN item" }).selectOption("14YD");
  await page.getByRole("combobox", { name: "Dump item" }).selectOption("DUMP");
  await page.getByRole("spinbutton", { name: "Estimated tonnes" }).fill("1.000");
  await page.getByRole("combobox", { name: "BIN service site" }).selectOption(SITE_ID);
  await page.getByRole("combobox", { name: "BIN workflow" }).selectOption("delivery");
  await page.getByRole("combobox", { name: "One-way delivery fee" }).selectOption("DELIVERY_CROSS_CHARGE");
  await page.getByLabel("Delivery date and time").fill("2037-08-03T12:00");
  await page.getByLabel("Return date and time").fill("2037-08-17T12:00");
  await page.getByRole("button", { name: "Create draft BIN quote" }).click();
  await expect(page.getByRole("heading", { name: "Quote MBT-Q-SYN-0137" })).toBeVisible();
  await expect(page.getByText("$536.75", { exact: true })).toBeVisible();
  await expect(page.getByText("12.5 km", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Issue quote" }).click();
  await page.getByRole("button", { name: "Accept quote" }).click();
  await page.getByRole("button", { name: "Convert to contract" }).click();
  await expect(page.getByRole("heading", { name: "Contract MBT-C-SYN-0137" })).toBeVisible();
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "Synthetic P3 Front Desk",
    password: PASSWORD,
    role: "mbt_frontdesk",
    roles: ["mbt_frontdesk"]
  });
});

test.afterAll(async () => {
  await removeFixture().catch(() => null);
});

test("P3-F13 browser: accessible quote-to-contract flow keeps search focus and exposes no posting action", async ({ page, request }) => {
  const calls = await installFrontdeskApi(page);
  await openFrontdesk(page, request);
  await expect(page.getByRole("heading", { name: "Front Desk", exact: true })).toBeVisible();
  await completeSyntheticConversion(page);

  await expect(page.getByText("Initial delivery")).toBeVisible();
  await expect(page.getByText("Ready · Front leg")).toBeVisible();
  await expect(page.getByText("Return bin")).toBeVisible();
  await expect(page.getByText("Tentative · waits for Initial delivery")).toBeVisible();
  await expect(page.getByRole("button", { name: /Post to NetSuite/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Create Sales Order/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Record customer deposit/i })).toHaveCount(0);

  expect(calls.map(({ path }) => path)).toEqual([
    "/api/mbt/frontdesk/quotes",
    `/api/mbt/frontdesk/quotes/${QUOTE_ID}/issue`,
    `/api/mbt/frontdesk/quotes/${QUOTE_ID}/accept`,
    `/api/mbt/frontdesk/quotes/${QUOTE_ID}/convert`
  ]);
  expect(calls.map(({ body }) => body.expectedRevision ?? null)).toEqual([null, 1, 2, 3]);
  expect(calls[0].body.serviceLines).toEqual([expect.objectContaining({
    binItemCode: "14YD",
    dumpItemCode: "DUMP",
    estimatedTonnes: "1.000"
  })]);
  expect(calls[0].body.deliveryItemCode).toBe("DELIVERY_CROSS_CHARGE");
  expect(calls[0].body.surcharges).toEqual([]);
  expect(calls.every(({ idempotencyKey }) => typeof idempotencyKey === "string" && idempotencyKey.length > 0)).toBe(true);
  expect(calls.some(({ path }) => /netsuite|sales.?order|deposit|post/i.test(path))).toBe(false);

  const accessibility = await new AxeBuilder({ page })
    .include("#mbtApp")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations.filter(({ impact }) => ["critical", "serious"].includes(impact))).toEqual([]);
});

test("P3-F14 browser: mobile extension edits only the future return and preserves the delivery timeline", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await installFrontdeskApi(page);
  await openFrontdesk(page, request);
  await expect(page.getByRole("heading", { name: "Front Desk", exact: true })).toBeVisible();
  await completeSyntheticConversion(page);
  await page.getByRole("button", { name: "Extend return" }).click();
  const dialog = page.getByRole("dialog", { name: "Extend return visit" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("New return date and time").fill("2037-08-24T12:00");
  await dialog.getByLabel("Return window end").fill("2037-08-24T16:00");
  await dialog.getByLabel("Audit reason").fill("Synthetic customer requested one more week");
  await dialog.getByRole("button", { name: "Approve extension" }).click();

  await expect(page.getByText("Initial delivery")).toBeVisible();
  await expect(page.getByText("03 Aug 2037", { exact: false })).toBeVisible();
  await expect(page.getByText("Return bin")).toBeVisible();
  await expect(page.getByText("24 Aug 2037", { exact: false })).toBeVisible();
  await expect(page.getByText("Approved extension 1")).toBeVisible();
  expect(calls.at(-1).path).toBe(`/api/mbt/frontdesk/contracts/${CONTRACT_ID}/extensions`);
  expect(calls.at(-1).body.expectedRevision).toBe(1);
  expect(calls.at(-1).body.reason).toBe("Synthetic customer requested one more week");
  expect(await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
  ))).toBe(true);
});
