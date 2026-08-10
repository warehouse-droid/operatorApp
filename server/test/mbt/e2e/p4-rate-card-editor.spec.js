import crypto from "node:crypto";

import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const SUFFIX = crypto.randomUUID().slice(0, 8);
const USERNAME = `mbt-rate-editor-${SUFFIX}`;
const PASSWORD = "mbt-rate-editor-browser-test";
const VERSION_ID = "d3c9fe42-94c9-4b4f-b5d9-5bc7c97e2a4b";

const VERSION = Object.freeze({
  rateCardVersionId: VERSION_ID,
  rateCardCode: "TORONTO_RENTAL",
  displayName: "Toronto rental pricing",
  versionNumber: 1,
  status: "draft",
  editable: true,
  effectiveFrom: "2026-08-01T00:00:00.000Z",
  revision: 5
});

const LOCAL_ITEMS = Object.freeze([
  {
    itemCode: "DELIVERY_CROSS_CHARGE",
    displayName: "Delivery Charge - MBT",
    description: "Item-owned delivery and cross-charge distance bands.",
    itemType: "delivery_fee",
    chargeBasis: "distance",
    rentalPeriodDays: null,
    priceMode: "rate_card",
    binTypeCode: null,
    localReady: true,
    active: true,
    revision: 1
  },
  {
    itemCode: "14YD",
    displayName: "14 yard bin",
    description: "Fixed rental period and daily extension.",
    itemType: "bin",
    chargeBasis: "rental_period",
    rentalPeriodDays: 14,
    priceMode: "rental_item",
    binTypeCode: "14YD",
    binCapacityYards: 14,
    localReady: true,
    active: true,
    revision: 1
  },
  {
    itemCode: "DUMP_MIXED",
    displayName: "Mixed waste",
    description: "Customer dump charge per tonne.",
    itemType: "dump",
    chargeBasis: "per_tonne",
    rentalPeriodDays: null,
    priceMode: "rate_card",
    binTypeCode: null,
    localReady: true,
    active: true,
    revision: 1
  },
  {
    itemCode: "DOWNTOWN_SURCHARGE",
    displayName: "Downtown surcharge",
    description: "Manually added surcharge.",
    itemType: "surcharge",
    chargeBasis: "per_event",
    rentalPeriodDays: null,
    priceMode: "manual",
    binTypeCode: null,
    localReady: true,
    active: true,
    revision: 1
  }
]);

const DUMP_SITE = Object.freeze({
  dumpSiteCode: "NORTH_DUMP",
  displayName: "North dump site",
  addressLine1: "100 Test Road",
  city: "Toronto",
  region: "ON",
  postalCode: "M1M 1M1",
  revision: 4,
  active: true,
  dumpItems: [{ itemCode: "DUMP_MIXED", accepted: true, scaleTicketRequired: true }],
  openingHours: [{ isoWeekday: 1, opensAt: "07:00", closesAt: "17:00" }]
});

function graph() {
  return {
    rateCard: {
      rateCardCode: VERSION.rateCardCode,
      displayName: VERSION.displayName
    },
    version: {
      effectiveFrom: VERSION.effectiveFrom,
      calculationNotes: "Fixed 14 Toronto calendar day rental."
    },
    components: [
      { itemCode: "14YD", componentKind: "rental", binTypeCode: "14YD", amountMinor: 15000 },
      { itemCode: "14YD", componentKind: "extension", binTypeCode: "14YD", amountMinor: 1200 }
    ],
    distanceBands: [
      {
        itemCode: "DELIVERY_CROSS_CHARGE", serviceCode: "delivery", binTypeCode: "14YD", minimumMetres: 0,
        maximumMetres: null, amountMinor: 12500
      }
    ],
    dumpTariffs: [{
      itemCode: "DUMP_MIXED", materialCode: null, amountMinor: 17500, minimumAmountMinor: 0
    }]
  };
}

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

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

async function installFixtures(page, calls) {
  await page.route("**/api/mbt/status", (route) => json(route, {
    capabilities: { billing: { enabled: false }, frontdesk: { enabled: false } }
  }));
  await page.route("**/api/mbt/config/local/items", (route) => json(route, { items: LOCAL_ITEMS }));
  await page.route("**/api/mbt/config/dump-sites", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await json(route, { entities: [DUMP_SITE] });
      return;
    }
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postDataJSON()
    });
    await json(route, { entity: DUMP_SITE });
  });
  await page.route("**/api/mbt/config/rate-cards**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/mbt/config/rate-cards") {
      await json(route, { items: [VERSION] });
      return;
    }
    if (request.method() === "GET" && path.endsWith(`/${VERSION_ID}`)) {
      await json(route, { version: VERSION, graph: graph() });
      return;
    }
    const body = request.postDataJSON();
    calls.push({ method: request.method(), path, body });
    if (request.method() === "PUT" && path.endsWith(`/${VERSION_ID}`)) {
      await json(route, { version: { ...VERSION, revision: 6 } });
      return;
    }
    if (request.method() === "POST" && path.endsWith("/validate")) {
      await json(route, { version: { ...VERSION, revision: 7, status: "validated" } });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unexpected rate-card request" }) });
  });
}

async function openConfiguration(page, request, calls) {
  await installFixtures(page, calls);
  const token = await tokenFor(request);
  await page.goto("/");
  await page.evaluate((value) => {
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "admin");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
  }, token);
  await page.goto("/mbt/config");
  await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeVisible();
}

async function openRateCards(page, request, calls) {
  await openConfiguration(page, request, calls);
  await page.getByRole("tab", { name: "Rate Cards" }).click();
  await expect(page.locator("#rateCardsPanel")).toBeVisible();
  await expect(page.locator("#rateCardRows").getByRole("button", { name: "Edit draft" })).toBeVisible();
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "MBT rate editor browser Admin",
    password: PASSWORD,
    role: "admin",
    roles: ["admin"]
  });
});

test.afterAll(async () => {
  await removeFixture().catch(() => null);
});

test("P4-R3 browser: a named draft edits each item through only its charging mechanism", async ({ page, request }) => {
  const calls = [];
  await openRateCards(page, request, calls);
  const panel = page.locator("#rateCardsPanel");

  await panel.locator("#rateCardRows").getByRole("button", { name: "Edit draft" }).click();
  await expect(panel.getByLabel("Rate card code")).toHaveValue("TORONTO_RENTAL");
  const pricingItem = panel.getByLabel("Pricing item");
  await expect(pricingItem.locator("option")).toHaveText([
    "Select a local item",
    "Delivery Charge - MBT · Delivery fee · configured",
    "14 yard bin · Bin · 14 cubic yards · configured",
    "Mixed waste · Dump · configured",
    "Downtown surcharge · Surcharge"
  ]);
  await expect(pricingItem).toHaveValue("DELIVERY_CROSS_CHARGE");

  const deliveryRows = panel.locator("#rateItemEditor [data-rate-kind='item_distance']");
  await expect(deliveryRows).toHaveCount(1);
  await panel.getByRole("button", { name: "Add distance band" }).click();
  await expect(deliveryRows).toHaveCount(2);
  await deliveryRows.nth(1).locator('[data-rate-field="minimumKm"]').fill("25");
  await deliveryRows.nth(1).locator('[data-rate-field="amountCad"]').fill("130.00");
  await deliveryRows.nth(1).getByRole("button", { name: "Remove" }).click();
  await expect(deliveryRows).toHaveCount(1);
  await deliveryRows.first().locator('[data-rate-field="amountCad"]').fill("130.00");

  await pricingItem.selectOption("DUMP_MIXED");
  await expect(panel.locator('#rateItemEditor [data-rate-field="amountCad"]')).toHaveValue("175.00");
  await panel.locator('#rateItemEditor [data-rate-field="amountCad"]').fill("180.00");
  await pricingItem.selectOption("14YD");
  await expect(panel.locator("#rateItemEditor")).toContainText("Fixed 14-day rental");
  await panel.locator('#rateItemEditor [data-rate-field="rentalCad"]').fill("160.00");
  await pricingItem.selectOption("DOWNTOWN_SURCHARGE");
  await expect(panel.locator("#rateItemEditor")).toContainText("added manually");

  await panel.getByLabel("Update note").fill("Update the item-owned browser pricing fixture");
  await panel.getByRole("button", { name: "Save draft changes" }).click();
  await expect(panel.locator("#rateCardsMessage")).toContainText("Draft changes saved");
  expect(calls[0]).toMatchObject({ method: "PUT", path: `/api/mbt/config/rate-cards/${VERSION_ID}` });
  expect(calls[0].body.expectedRevision).toBe(5);
  expect(calls[0].body.graph.distanceBands).toEqual(expect.arrayContaining([
    expect.objectContaining({
      itemCode: "DELIVERY_CROSS_CHARGE", serviceCode: "delivery", amountMinor: 13000
    })
  ]));
  expect(calls[0].body.graph.dumpTariffs).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemCode: "DUMP_MIXED", materialCode: null, amountMinor: 18000 })
  ]));
  expect(calls[0].body.graph.components).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemCode: "14YD", componentKind: "rental", amountMinor: 16000 })
  ]));

  await panel.getByRole("button", { name: "Validate draft" }).click();
  await expect(panel.locator("#rateCardsMessage")).toContainText("Rate-card validate completed locally");
  expect(calls[1]).toMatchObject({
    method: "POST",
    path: `/api/mbt/config/rate-cards/${VERSION_ID}/validate`,
    body: { expectedRevision: 6 }
  });
});

test("P4-R3 browser: dump sites select item-owned dump charges for create and optimistic update", async ({ page, request }) => {
  const calls = [];
  await openConfiguration(page, request, calls);
  await page.getByRole("tab", { name: "Dump Sites" }).click();
  const panel = page.locator("#materialsDumpSitesPanel");
  await expect(panel).toBeVisible();

  await panel.locator("#dumpSiteRows").getByRole("button", { name: "Edit" }).click();
  const acceptedItem = panel.locator('[data-dump-acceptance-item][value="DUMP_MIXED"]');
  await expect(acceptedItem).toBeChecked();
  await panel.locator('[data-dump-ticket-item="DUMP_MIXED"]').uncheck();
  await panel.getByLabel("Update note").fill("Use the item-owned dump acceptance fixture");
  await panel.getByRole("button", { name: "Update dump site" }).click();
  await expect(panel.locator("#masterDataMessage")).toContainText("Dump site updated");
  expect(calls.find(({ path }) => path === "/api/mbt/config/dump-sites")).toMatchObject({
    method: "POST",
    body: expect.objectContaining({
      dumpSiteCode: "NORTH_DUMP",
      itemAcceptances: [expect.objectContaining({
        itemCode: "DUMP_MIXED",
        scaleTicketRequired: false
      })],
      expectedRevision: 4
    })
  });

  await panel.getByRole("button", { name: "New dump site" }).click();
  await panel.getByLabel("Code", { exact: true }).fill("WEST_DUMP");
  await panel.getByLabel("Name", { exact: true }).fill("West dump site");
  await panel.locator('[data-dump-acceptance-item][value="DUMP_MIXED"]').check();
  await panel.getByRole("button", { name: "Create dump site" }).click();
  await expect(panel.locator("#masterDataMessage")).toContainText("Dump site created");
  const dumpCreates = calls.filter(({ path }) => path === "/api/mbt/config/dump-sites");
  expect(dumpCreates[1]).toMatchObject({
    method: "POST",
    body: {
      dumpSiteCode: "WEST_DUMP",
      displayName: "West dump site",
      itemAcceptances: [expect.objectContaining({ itemCode: "DUMP_MIXED" })]
    }
  });
  expect(dumpCreates[1].body).not.toHaveProperty("expectedRevision");
});
