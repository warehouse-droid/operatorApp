import { expect, test } from "./mbt-e2e-test.js";

const VERSION_ID = "00000000-0000-4000-8000-000000000361";
const CLONE_ID = "00000000-0000-4000-8000-000000000362";

const LOCAL_ITEMS = Object.freeze([
  {
    itemCode: "DELIVERY_CROSS_CHARGE",
    displayName: "Delivery Charge - MBT",
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
    itemCode: "CLEAN_FILL",
    displayName: "Clean fill",
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
    itemCode: "CONCRETE",
    displayName: "Concrete",
    itemType: "dump",
    chargeBasis: "per_bin",
    rentalPeriodDays: null,
    priceMode: "rate_card",
    binTypeCode: null,
    localReady: true,
    active: true,
    revision: 1
  },
  {
    itemCode: "AGG_HPB",
    displayName: "HPB",
    itemType: "aggregate",
    chargeBasis: "per_yard",
    densityLbsPerYard: 2600,
    rentalPeriodDays: null,
    priceMode: "rate_card",
    binTypeCode: null,
    localReady: true,
    active: true,
    revision: 1
  },
  {
    itemCode: "OVERTIME_SURCHARGE",
    displayName: "Overtime surcharge",
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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function version({ id = VERSION_ID, revision = 1, editable = true } = {}) {
  return {
    rateCardVersionId: id,
    rateCardCode: "P3_BROWSER",
    displayName: "P3 browser rates",
    versionNumber: 1,
    revision,
    status: "draft",
    editable,
    effectiveFrom: "2038-08-03T12:00:00.000Z"
  };
}

function rateDetail(currentVersion = version()) {
  return {
    schemaVersion: "mbt-rate-card-detail-v1",
    version: currentVersion,
    graph: {
      rateCard: { rateCardCode: currentVersion.rateCardCode, displayName: currentVersion.displayName },
      version: { effectiveFrom: currentVersion.effectiveFrom, calculationNotes: "Browser test rate card" },
      components: [
        { itemCode: "14YD", componentKind: "rental", binTypeCode: "14YD", amountMinor: 10000 },
        { itemCode: "14YD", componentKind: "extension", binTypeCode: "14YD", amountMinor: 1000 }
      ],
      distanceBands: [
        {
          itemCode: "DELIVERY_CROSS_CHARGE", serviceCode: "delivery", binTypeCode: "14YD",
          minimumMetres: 0, maximumMetres: null, amountMinor: 15000
        }
      ],
      dumpTariffs: [{
        itemCode: "CLEAN_FILL", materialCode: null, amountMinor: 17500, minimumAmountMinor: 0
      }],
      depositRules: []
    }
  };
}

function customerChargeConfiguration(revision = 0) {
  return {
    schemaVersion: "mbt-frontdesk-customer-charge-admin-configuration-v1",
    rateCardVersionId: VERSION_ID,
    revision,
    complete: revision > 0,
    aggregateLoadingFeeMinor: 5_000,
    aggregateItems: [
      { itemCode: "AGG_CLEAR_LIMESTONE_34", amountMinor: null, densityLbsPerYard: null },
      { itemCode: "AGG_CRUSHER_RUN", amountMinor: null, densityLbsPerYard: null },
      { itemCode: "AGG_HPB", amountMinor: null, densityLbsPerYard: null },
      { itemCode: "AGG_SCREENING", amountMinor: null, densityLbsPerYard: null }
    ],
    fixedDumpItems: [
      { itemCode: "DUMP_SOIL", amountMinor: null },
      { itemCode: "DUMP_ASPHALT", amountMinor: null },
      { itemCode: "DUMP_CONCRETE", amountMinor: null }
    ],
    aggregateDistanceBands: []
  };
}

async function handleConfigReads(route, request, path, state) {
  if (path === "/api/auth/me") {
    await json(route, { operator: { roles: ["admin"] } });
    return true;
  }
  if (path === "/api/mbt/status") {
    await json(route, {
      capabilities: { frontdesk: { enabled: false }, billing: { enabled: false }, dispatch: { enabled: false } }
    });
    return true;
  }
  if (path === "/api/mbt/config/local/items" && request.method() === "GET") {
    await json(route, { items: state.localItems });
    return true;
  }
  if (path === "/api/mbt/config/dump-sites" && request.method() === "GET") {
    await json(route, { entities: state.sites });
    return true;
  }
  return false;
}

async function handleMasterDataWrites(route, request, path, calls, state) {
  if (path === "/api/mbt/config/local/items" && request.method() === "POST") {
    const body = request.postDataJSON();
    calls.push({ method: request.method(), path, body });
    const entity = {
      ...body,
      localReady: true,
      active: body.active !== false,
      revision: 1
    };
    state.localItems.push(entity);
    await json(route, { entities: [entity] }, 201);
    return true;
  }
  if (path.startsWith("/api/mbt/config/local/items/") && request.method() === "PUT") {
    const itemCode = decodeURIComponent(path.slice("/api/mbt/config/local/items/".length));
    const body = request.postDataJSON();
    calls.push({ method: request.method(), path, body });
    const index = state.localItems.findIndex((item) => item.itemCode === itemCode);
    const entity = {
      ...state.localItems[index],
      ...body,
      itemCode,
      revision: Number(state.localItems[index]?.revision || 0) + 1
    };
    state.localItems[index] = entity;
    await json(route, { item: entity });
    return true;
  }
  if (path === "/api/mbt/config/dump-sites" && request.method() === "POST") {
    const body = request.postDataJSON();
    calls.push({ path, body });
    const existing = state.sites.findIndex((item) => item.dumpSiteCode === body.dumpSiteCode);
    const entity = {
      dumpSiteCode: body.dumpSiteCode,
      displayName: body.displayName,
      addressLine1: body.addressLine1,
      city: body.city,
      region: body.region,
      postalCode: body.postalCode,
      revision: existing < 0 ? 1 : 2,
      active: body.active,
      dumpItems: body.itemAcceptances,
      openingHours: body.openingHours
    };
    if (existing < 0) {
      state.sites.push(entity);
    } else {
      state.sites[existing] = entity;
    }
    await json(route, { entity }, 201);
    return true;
  }
  return false;
}

async function handleRateCardRequests(route, request, path, calls, state) {
  if (path === "/api/mbt/config/rate-cards" && request.method() === "GET") {
    await json(route, { items: [state.currentVersion] });
    return true;
  }
  if (path === "/api/mbt/config/rate-cards" && request.method() === "POST") {
    const body = request.postDataJSON();
    calls.push({ path, body });
    state.currentVersion = {
      ...version({ revision: 1 }),
      rateCardCode: body.graph.rateCard.rateCardCode,
      displayName: body.graph.rateCard.displayName
    };
    await json(route, { version: state.currentVersion }, 201);
    return true;
  }
  if ([
    `/api/mbt/config/rate-cards/${VERSION_ID}`,
    `/api/mbt/config/rate-cards/${CLONE_ID}`
  ].includes(path) && request.method() === "GET") {
    await json(route, rateDetail(state.currentVersion));
    return true;
  }
  if (path === `/api/mbt/config/rate-cards/${VERSION_ID}` && request.method() === "PUT") {
    const body = request.postDataJSON();
    calls.push({ path, body });
    state.currentVersion = { ...state.currentVersion, revision: 2 };
    await json(route, { version: state.currentVersion });
    return true;
  }
  if (path === `/api/mbt/config/rate-cards/${VERSION_ID}/clone` && request.method() === "POST") {
    const body = request.postDataJSON();
    calls.push({ path, body });
    state.currentVersion = {
      ...version({ id: CLONE_ID, revision: 1 }),
      rateCardCode: "P3_BROWSER_COPY",
      displayName: "P3 browser rates copy"
    };
    await json(route, { version: state.currentVersion }, 201);
    return true;
  }
  return false;
}

async function handleCustomerChargeRequests(route, request, path, calls, state) {
  if (path !== `/api/mbt/config/customer-charges/${VERSION_ID}`) {
    return false;
  }
  if (request.method() === "GET") {
    await json(route, state.customerChargeConfiguration);
    return true;
  }
  if (request.method() === "PUT") {
    const body = request.postDataJSON();
    calls.push({ path, body });
    state.customerChargeConfiguration = {
      ...customerChargeConfiguration(Number(body.expectedRevision) + 1),
      aggregateItems: body.aggregateItems,
      fixedDumpItems: body.fixedDumpItems,
      aggregateDistanceBands: body.aggregateDistanceBands
    };
    await json(route, { configuration: state.customerChargeConfiguration }, 201);
    return true;
  }
  return false;
}

async function installConfigApi(page) {
  const calls = [];
  const state = {
    sites: [],
    localItems: LOCAL_ITEMS.map((item) => ({ ...item })),
    currentVersion: version(),
    customerChargeConfiguration: customerChargeConfiguration()
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await handleConfigReads(route, request, path, state)) {
      return;
    }
    if (await handleMasterDataWrites(route, request, path, calls, state)) {
      return;
    }
    if (await handleRateCardRequests(route, request, path, calls, state)) {
      return;
    }
    if (await handleCustomerChargeRequests(route, request, path, calls, state)) {
      return;
    }
    await json(route, { error: `Unexpected browser route: ${request.method()} ${path}` }, 404);
  });
  return calls;
}

async function openConfig(page) {
  await page.goto("/");
  await page.evaluate(() => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem("mbbs.staff.token", "synthetic-admin-token");
    globalThis.localStorage.setItem("mbbs.staff.role", "admin");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
  });
  await page.goto("/mbt/config");
  await expect(page.locator(".mbt-status")).toHaveAttribute("aria-busy", "false");
}

test("item-owned setup creates per-yard aggregate and changes a dump item to fixed per bin", async ({ page }) => {
  const calls = await installConfigApi(page);
  await openConfig(page);

  await expect(page.getByRole("tab", { name: "Customer Charges" })).toHaveCount(0);
  await expect(page.locator("#customerChargesPanel")).toHaveCount(0);

  const createItem = page.locator("#customLocalItemForm");
  await createItem.getByLabel("Item type").selectOption("aggregate");
  await expect(createItem.getByLabel("Charging method")).toHaveValue("per_yard");
  await expect(createItem.getByLabel("Charging method").locator("option:checked")).toHaveText("Price per cubic yard");
  await createItem.getByLabel("Item code").fill("AGG_GRANITE_TEST");
  await createItem.getByLabel("Display name").fill("Granite test aggregate");
  await createItem.getByLabel("Density (lb / yard)").fill("2750");
  await createItem.getByRole("button", { name: "Create custom item" }).click();
  await expect(page.locator("#localItemRows")).toContainText("Granite test aggregate");
  await expect(page.locator("#localItemRows")).toContainText("Price per cubic yard");

  await page.getByRole("button", { name: "Edit CLEAN_FILL" }).click();
  const editor = page.locator("#localItemEditor");
  await expect(editor.getByLabel("Charging method")).toHaveValue("per_tonne");
  await editor.getByLabel("Charging method").selectOption("per_bin");
  await editor.getByLabel("Audit reason").fill("Use the fixed customer price for each clean-fill bin");
  await editor.getByRole("button", { name: "Save local item" }).click();
  await expect(page.locator("#localItemRows")).toContainText("Fixed price per bin");

  const create = calls.find((call) => call.path === "/api/mbt/config/local/items" && call.method === "POST");
  expect(create.body).toEqual(expect.objectContaining({
    itemCode: "AGG_GRANITE_TEST",
    itemType: "aggregate",
    chargeBasis: "per_yard",
    densityLbsPerYard: 2750,
    applicableServiceTypes: ["delivery", "exchange"]
  }));
  const update = calls.find((call) => call.path === "/api/mbt/config/local/items/CLEAN_FILL");
  expect(update.body).toEqual(expect.objectContaining({
    chargeBasis: "per_bin",
    expectedRevision: 1,
    reason: "Use the fixed customer price for each clean-fill bin"
  }));
});

test("P4 browser: dump sites and item-owned pricing use only the charging fields allowed by each item", async ({ page }) => {
  const calls = await installConfigApi(page);
  await openConfig(page);

  await page.getByRole("tab", { name: "Dump Sites" }).click();
  await expect(page.locator("#dumpSiteItemAcceptances")).toContainText("Clean fill · CLEAN_FILL");
  await expect(page.locator("#dumpSiteItemAcceptances")).toContainText("Concrete · CONCRETE");
  await page.locator("#dumpSiteCode").fill("P4_DUMP");
  await page.locator("#dumpSiteName").fill("P4 test dump");
  await page.locator('[data-dump-acceptance-item][value="CLEAN_FILL"]').check();
  await page.locator('[data-dump-acceptance-item][value="CONCRETE"]').check();
  await page.locator('[data-dump-opening-day][value="6"]').check();
  const saturdayHours = page.locator(".mbt-dump-hours-row").filter({ has: page.locator('[data-dump-opening-day][value="6"]') });
  await saturdayHours.locator("[data-dump-opens]").fill("08:00");
  await saturdayHours.locator("[data-dump-closes]").fill("12:00");
  await page.locator("#dumpSiteForm").getByRole("button", { name: "Create dump site" }).click();
  await expect(page.locator("#dumpSiteRows")).toContainText("P4 test dump");
  await expect(page.locator("#dumpSiteRows")).toContainText("CLEAN_FILL, CONCRETE");
  await expect(page.locator("#dumpSiteRows")).toContainText("Sat 08:00–12:00");
  const editDumpSite = page.locator("#dumpSiteRows").getByRole("button", { name: "Edit" });
  await editDumpSite.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-dump-acceptance-item][value="CLEAN_FILL"]')).toBeChecked();
  await expect(page.locator('[data-dump-acceptance-item][value="CONCRETE"]')).toBeChecked();
  await expect(page.locator('[data-dump-opening-day][value="6"]')).toBeChecked();
  await page.locator("#dumpSiteName").fill("P4 test dump revised");
  await page.locator("#dumpSiteReason").fill("Revise the browser fixture");
  await page.locator("#dumpSiteForm").getByRole("button", { name: "Update dump site" }).click();

  await page.getByRole("tab", { name: "Rate Cards" }).click();
  await expect(page.locator("#rateCardsPanel")).toBeVisible();
  await page.getByRole("button", { name: "Create new rate card" }).click();
  const pricingItem = page.getByLabel("Pricing item");
  await expect(pricingItem.locator("option")).toHaveText([
    "Select a local item",
    "Delivery Charge - MBT · Delivery fee",
    "14 yard bin · Bin · 14 cubic yards",
    "Clean fill · Dump",
    "Concrete · Dump",
    "HPB · Aggregate",
    "Overtime surcharge · Surcharge"
  ]);

  await pricingItem.selectOption("14YD");
  await expect(page.locator("#rateItemEditor")).toContainText("Fixed 14-day rental");
  await page.locator('#rateItemEditor [data-rate-field="rentalCad"]').fill("100.00");
  await page.locator('#rateItemEditor [data-rate-field="extensionCad"]').fill("10.00");

  await pricingItem.selectOption("CLEAN_FILL");
  await expect(page.locator("#rateItemEditor")).toContainText("Customer charge per tonne");
  await page.locator('#rateItemEditor [data-rate-field="amountCad"]').fill("175.00");
  await page.locator('#rateItemEditor [data-rate-field="minimumCad"]').fill("20.00");

  await pricingItem.selectOption("CONCRETE");
  await expect(page.locator("#rateItemEditor")).toContainText("Fixed customer charge for each bin");
  await expect(page.locator('#rateItemEditor [data-rate-field="minimumCad"]')).toHaveCount(0);
  await page.locator('#rateItemEditor [data-rate-field="amountCad"]').fill("725.00");

  await pricingItem.selectOption("AGG_HPB");
  await expect(page.locator("#rateItemEditor")).toContainText("Customer charge per cubic yard");
  await expect(page.locator("#rateItemEditor")).toContainText("2600 lb per yard");
  await page.locator('#rateItemEditor [data-rate-field="amountCad"]').fill("65.00");

  await pricingItem.selectOption("OVERTIME_SURCHARGE");
  await expect(page.locator("#rateItemEditor")).toContainText("added manually");
  await expect(page.locator("#rateItemEditor input")).toHaveCount(0);

  await pricingItem.selectOption("DELIVERY_CROSS_CHARGE");
  await page.getByRole("button", { name: "Add distance band" }).click();
  await page.getByRole("button", { name: "Add distance band" }).click();
  const deliveryRows = page.locator("#rateItemEditor [data-rate-kind='item_distance']");
  await expect(deliveryRows).toHaveCount(2);
  await deliveryRows.nth(0).locator('[data-rate-field="minimumKm"]').fill("0");
  await deliveryRows.nth(0).locator('[data-rate-field="maximumKm"]').fill("9");
  await deliveryRows.nth(0).locator('[data-rate-field="amountCad"]').fill("100.00");
  await deliveryRows.nth(1).locator('[data-rate-field="minimumKm"]').fill("10");
  await deliveryRows.nth(1).locator('[data-rate-field="amountCad"]').fill("150.00");

  await page.locator("#rateCardCode").fill("P4_BROWSER");
  await page.locator("#rateCardDisplayName").fill("P4 browser rates");
  await page.locator("#rateCardEffectiveFrom").fill("2038-08-03T08:00");
  const requestsBeforeGap = calls.length;
  await page.locator("#rateCardForm").getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("#rateCardsMessage")).toContainText("bands have a gap");
  expect(calls).toHaveLength(requestsBeforeGap);
  await deliveryRows.nth(0).locator('[data-rate-field="maximumKm"]').fill("10");
  await page.locator("#rateCardForm").getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("#rateCardsMessage")).toContainText("Local draft saved");
  const creates = calls.filter((call) => call.path === "/api/mbt/config/rate-cards");
  expect(creates).toHaveLength(1);
  expect(creates[0].body.graph.version.effectiveFrom).toBe("2038-08-03T12:00:00.000Z");

  const requestsBeforeNonexistentTime = calls.length;
  await page.locator("#rateCardEffectiveFrom").fill("2038-03-14T02:30");
  await page.locator("#rateCardReason").fill("Exercise the Toronto daylight-saving validation");
  await page.locator("#rateCardForm button[type='submit']").click();
  await expect(page.locator("#rateCardsMessage")).toContainText("does not exist");
  expect(calls).toHaveLength(requestsBeforeNonexistentTime);

  await page.locator("#rateCardRows").getByRole("button", { name: "Edit draft" }).click();
  await expect(page.locator("#rateCardForm button[type='submit']")).toHaveText("Save draft changes");
  await page.locator("#ratePricingItem").selectOption("14YD");
  await page.locator('#rateItemEditor [data-rate-field="rentalCad"]').fill("120.00");
  await page.locator("#rateCardReason").fill("Update the BIN rental browser fixture");
  await page.locator("#rateCardForm button[type='submit']").click();
  await page.getByRole("button", { name: "Clone as new draft" }).click();
  await expect(page.locator("#rateCardVersionId")).toHaveValue(CLONE_ID);

  expect(calls.filter((call) => call.path === "/api/mbt/config/dump-sites")).toHaveLength(2);
  const dumpSiteCreates = calls.filter((call) => call.path === "/api/mbt/config/dump-sites");
  expect(dumpSiteCreates[0].body.itemAcceptances).toEqual([
    expect.objectContaining({ itemCode: "CLEAN_FILL", accepted: true }),
    expect.objectContaining({ itemCode: "CONCRETE", accepted: true })
  ]);
  expect(dumpSiteCreates[0].body.openingHours).toEqual(expect.arrayContaining([
    { isoWeekday: 1, opensAt: "07:00", closesAt: "17:00" },
    { isoWeekday: 6, opensAt: "08:00", closesAt: "12:00" }
  ]));
  // Multi-item rate cards leave the header unowned; child rows retain item ownership.
  expect(creates[0].body.graph.rateCard.itemCode).toBeNull();
  expect(creates[0].body.graph.components).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemCode: "14YD", componentKind: "rental", amountMinor: 10000 }),
    expect.objectContaining({ itemCode: "14YD", componentKind: "extension", amountMinor: 1000 })
  ]));
  expect(creates[0].body.graph.components).toHaveLength(2);
  expect(creates[0].body.graph.dumpTariffs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      itemCode: "CLEAN_FILL", pricingBasis: "per_weight", unitOfMeasure: "TONNE",
      amountMinor: 17500, minimumAmountMinor: 2000
    }),
    expect.objectContaining({
      itemCode: "CONCRETE", pricingBasis: "per_quantity", unitOfMeasure: "BIN",
      amountMinor: 72500, minimumAmountMinor: 0
    }),
    expect.objectContaining({
      itemCode: "AGG_HPB", pricingBasis: "per_quantity", unitOfMeasure: "YARD",
      amountMinor: 6500, minimumAmountMinor: 0
    })
  ]));
  expect(creates[0].body.graph.dumpTariffs).toHaveLength(3);
  expect(creates[0].body.graph.distanceBands).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemCode: "DELIVERY_CROSS_CHARGE", minimumMetres: 0, maximumMetres: 10000 }),
    expect.objectContaining({ itemCode: "DELIVERY_CROSS_CHARGE", minimumMetres: 10000, maximumMetres: null })
  ]));
  expect(creates[0].body.graph.distanceBands).toHaveLength(2);
  const updates = calls.filter((call) => call.path === `/api/mbt/config/rate-cards/${VERSION_ID}`);
  expect(updates.at(-1).body.graph.rateCard.itemCode).toBeNull();
  expect(updates.at(-1).body.graph.components).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemCode: "14YD", componentKind: "rental", amountMinor: 12000 })
  ]));
  expect(calls.some((call) => call.path.endsWith("/clone"))).toBe(true);
  const overflow = await page.evaluate(() => (
    globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth
  ));
  expect(overflow).toBeLessThanOrEqual(1);
});
