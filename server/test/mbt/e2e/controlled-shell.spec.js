import crypto from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const PASSWORD = "phase-one-browser";
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ACCOUNTS = Object.freeze({
  admin: `mbt-e2e-admin-${RUN_ID}`,
  operator: `mbt-e2e-operator-${RUN_ID}`,
  dispatcher: `mbt-e2e-dispatcher-${RUN_ID}`,
  scm: `mbt-e2e-scm-${RUN_ID}`,
  yard_manager: `mbt-e2e-yard-manager-${RUN_ID}`,
  sales: `mbt-e2e-sales-${RUN_ID}`,
  mbt_frontdesk: `mbt-e2e-frontdesk-${RUN_ID}`,
  mbt_billing: `mbt-e2e-billing-${RUN_ID}`,
  mbt_dual: `mbt-e2e-dual-${RUN_ID}`
});
const AUTH_STORAGE_KEYS = Object.freeze([
  "mbbs.control.token",
  "mbbs.operator.token",
  "mbbs.dispatch.token",
  "mbbs.staff.token",
  "mbbs.staff.role",
  "mbbs.staff.roles",
  "mbbs.driver.token"
]);
const MBT_LINKS = Object.freeze([
  "/mbt/frontdesk",
  "/mbt/billing",
  "/mbt/assets",
  "/mbt/config"
]);
const LEGACY_LOGIN_CASES = Object.freeze([
  { account: "operator", path: "/operator", storageKey: "mbbs.operator.token" },
  { account: "dispatcher", path: "/dispatch", storageKey: "mbbs.dispatch.token" },
  { account: "admin", path: "/admin", storageKey: "mbbs.control.token" },
  { account: "scm", path: "/scm", storageKey: "mbbs.dispatch.token" },
  { account: "yard_manager", path: "/control", storageKey: "mbbs.control.token" },
  { account: "sales", path: "/sales", storageKey: "mbbs.dispatch.token" }
]);

async function removeFixtures() {
  const usernames = Object.values(ACCOUNTS);
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = ANY($1::text[]))",
    [usernames]
  );
  await query("DELETE FROM operators WHERE username = ANY($1::text[])", [usernames]);
}

async function tokenFor(request, role) {
  const response = await request.post("/api/auth/login", {
    data: { username: ACCOUNTS[role], password: PASSWORD }
  });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

async function expectMbtSurfaceReady(page, path) {
  if (path === "/mbt/frontdesk") {
    await expect(page.locator("#frontdeskMessage"))
      .toHaveText("This MBT capability is disabled.");
    return;
  }
  await expect(page.locator(".mbt-status")).toHaveAttribute("aria-busy", "false");
}

async function openAs(page, request, account, path, {
  primaryRole = account,
  grantedRoles = [primaryRole]
} = {}) {
  const token = await tokenFor(request, account);
  await page.goto("/");
  await page.evaluate(({ keys, primaryRole: storedRole, grantedRoles: storedRoles, value }) => {
    for (const key of keys) {
      globalThis.localStorage.removeItem(key);
    }
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", storedRole);
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(storedRoles));
  }, {
    keys: AUTH_STORAGE_KEYS,
    primaryRole,
    grantedRoles,
    value: token
  });
  await page.goto(path);
  await expect(page.locator("#mbtApp")).toBeVisible();
  await expectMbtSurfaceReady(page, path);
}

async function storedAuth(page) {
  return page.evaluate((keys) => Object.fromEntries(
    keys.map((key) => [key, globalThis.localStorage.getItem(key)])
  ), AUTH_STORAGE_KEYS);
}

async function captureNextRealStaffLogin(page) {
  const result = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/auth/login"
  ).then((response) => ({ status: response.status() }))
    .catch((error) => ({ error }));
  return { result };
}

async function loginFromRoot(page, {
  account,
  expectedPath,
  expectedRole,
  expectedRoles,
  expectedModuleTokenKey = null,
  expectedToken = null
}) {
  await page.goto("/");
  await page.evaluate((keys) => {
    for (const key of keys) {
      globalThis.localStorage.setItem(key, "stale-auth-value");
    }
  }, AUTH_STORAGE_KEYS);
  await page.locator("input[name='username']").fill(ACCOUNTS[account]);
  await page.locator("input[name='password']").fill(PASSWORD);
  const realLogin = expectedToken === null ? await captureNextRealStaffLogin(page) : null;
  await page.locator("[data-form='root-login'] button[type='submit']").click();
  const captured = realLogin ? await realLogin.result : { status: 200 };
  expect(captured.error).toBeUndefined();
  expect(captured.status).toBe(200);
  await expect(page).toHaveURL(new RegExp(`${expectedPath.replaceAll("/", "\\/")}$`));
  if (expectedPath.startsWith("/mbt/")) {
    await expectMbtSurfaceReady(page, expectedPath);
  }
  const actualStorage = await storedAuth(page);
  const issuedToken = expectedToken ?? actualStorage["mbbs.staff.token"];
  expect(issuedToken).toEqual(expect.any(String));
  const expectedStorage = Object.fromEntries(AUTH_STORAGE_KEYS.map((key) => [key, null]));
  expectedStorage["mbbs.staff.token"] = issuedToken;
  expectedStorage["mbbs.staff.role"] = expectedRole;
  expectedStorage["mbbs.staff.roles"] = JSON.stringify(expectedRoles);
  if (expectedModuleTokenKey) {
    expectedStorage[expectedModuleTokenKey] = issuedToken;
  }
  expect(actualStorage).toEqual(expectedStorage);
  return { token: issuedToken };
}

async function expectMbtLinks(page, allowed) {
  await expect(page.locator("#appSidebar")).toBeVisible();
  for (const href of MBT_LINKS) {
    await expect(page.locator(`#appSidebar a.app-sidebar-link[href='${href}']`))
      .toHaveCount(allowed.includes(href) ? 1 : 0);
  }
}

test.beforeAll(async () => {
  await removeFixtures();
  for (const [role, username] of Object.entries(ACCOUNTS)) {
    if (role === "mbt_dual") {
      continue;
    }
    await createOperator({
      username,
      displayName: `MBT E2E ${role}`,
      password: PASSWORD,
      role,
      roles: [role]
    });
  }
  await createOperator({
    username: ACCOUNTS.mbt_dual,
    displayName: "MBT E2E dual authority",
    password: PASSWORD,
    role: "operator",
    roles: ["operator", "mbt_frontdesk", "mbt_billing"]
  });
});

test.afterAll(async () => {
  await removeFixtures().catch(() => null);
});

test("F02/F15: root login redirects MBT staff and places only normalized staff auth", async ({ page }) => {
  for (const fixture of [
    {
      account: "mbt_frontdesk",
      expectedPath: "/mbt/frontdesk",
      expectedRole: "mbt_frontdesk",
      expectedRoles: ["mbt_frontdesk"]
    },
    {
      account: "mbt_billing",
      expectedPath: "/mbt/billing",
      expectedRole: "mbt_billing",
      expectedRoles: ["mbt_billing"]
    }
  ]) {
    await loginFromRoot(page, fixture);
  }
});

for (const fixture of LEGACY_LOGIN_CASES) {
  test(`F02 non-regression: root login preserves the ${fixture.account} route and token contract`, async ({ page }) => {
    await loginFromRoot(page, {
      account: fixture.account,
      expectedPath: fixture.path,
      expectedRole: fixture.account,
      expectedRoles: [fixture.account],
      expectedModuleTokenKey: fixture.storageKey
    });
  });
}

test("F02/F15: root login normalizes mixed authorities before redirect and storage", async ({ page, request }) => {
  const token = await tokenFor(request, "mbt_frontdesk");
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token,
        operator: {
          role: " Operator ",
          roles: [" MBT Frontdesk ", "mbt-frontdesk", "operator"],
          homeRoute: "/mbt/frontdesk"
        }
      })
    });
  });
  await loginFromRoot(page, {
    account: "mbt_frontdesk",
    expectedPath: "/mbt/frontdesk",
    expectedRole: "operator",
    expectedRoles: ["mbt_frontdesk", "operator"],
    expectedToken: token
  });
});

test("F02/F15: root login rejects a home route not granted by returned authorities", async ({ page }) => {
  let staffCalls = 0;
  let driverCalls = 0;
  await page.route("**/api/auth/login", async (route) => {
    staffCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: "must-not-be-stored",
        operator: {
          role: "mbt_frontdesk",
          roles: ["mbt_frontdesk"],
          homeRoute: "/mbt/billing"
        }
      })
    });
  });
  await page.route("**/api/driver/login", async (route) => {
    driverCalls += 1;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Driver fallback denied." })
    });
  });
  await page.goto("/");
  await page.evaluate((keys) => {
    for (const key of keys) {
      globalThis.localStorage.removeItem(key);
    }
  }, AUTH_STORAGE_KEYS);
  await page.locator("input[name='username']").fill("mismatched-route");
  await page.locator("input[name='password']").fill(PASSWORD);
  await page.locator("[data-form='root-login'] button[type='submit']").click();
  await expect(page.locator(".login-notice")).toHaveText("Driver fallback denied.");
  await expect(page).toHaveURL(/\/$/);
  expect(staffCalls).toBe(1);
  expect(driverCalls).toBe(1);
  expect(await storedAuth(page)).toEqual(
    Object.fromEntries(AUTH_STORAGE_KEYS.map((key) => [key, null]))
  );
});

test("F02/F15: MBT sidebar renders every permitted link exactly once", async ({ page, request }) => {
  for (const fixture of [
    {
      role: "mbt_frontdesk",
      path: "/mbt/frontdesk",
      grantedRoles: ["mbt_frontdesk"],
      allowed: ["/mbt/frontdesk"]
    },
    {
      role: "mbt_billing",
      path: "/mbt/billing",
      grantedRoles: ["mbt_billing"],
      allowed: ["/mbt/billing"]
    },
    {
      role: "mbt_dual",
      path: "/mbt/frontdesk",
      primaryRole: "operator",
      grantedRoles: ["operator", "mbt_frontdesk", "mbt_billing"],
      allowed: ["/mbt/frontdesk", "/mbt/billing"]
    }
  ]) {
    await openAs(page, request, fixture.role, fixture.path, {
      primaryRole: fixture.primaryRole,
      grantedRoles: fixture.grantedRoles
    });
    await expectMbtLinks(page, fixture.allowed);
  }

  await openAs(page, request, "admin", "/mbt/config");
  await expectMbtLinks(page, MBT_LINKS);
});

test("P3-F29: Admin can operate a local gate from the responsive audited control page", async ({ page, request }) => {
  let configured = false;
  let revision = 7;
  const commands = [];
  await page.route("**/api/mbt/config/gates**", async (route) => {
    const requestPath = new URL(route.request().url()).pathname;
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      commands.push({
        path: requestPath,
        idempotencyKey: route.request().headers()["idempotency-key"],
        body
      });
      configured = body.enabled === true;
      revision += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          flag: {
            flagKey: "mbt_master_data",
            enabled: configured,
            revision
          }
        })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "mbt-admin-gates-v1",
        safetyProfile: "local_non_posting",
        environmentRootAllowed: true,
        gates: [
          {
            flagKey: "mbt_master_data",
            label: "Local master data",
            description: "Customer file imports and local setup.",
            present: true,
            configured,
            environmentAllowed: true,
            effective: configured,
            locked: false,
            lockReason: null,
            revision,
            updatedBy: null,
            updatedAt: null
          },
          {
            flagKey: "mbt_customer_sync",
            label: "Live customer sync",
            description: "Direct customer synchronization from NetSuite.",
            present: true,
            configured: false,
            environmentAllowed: false,
            effective: false,
            locked: true,
            lockReason: "Live customer synchronization remains closed during local testing.",
            revision: 2,
            updatedBy: null,
            updatedAt: null
          }
        ]
      })
    });
  });

  await openAs(page, request, "admin", "/admin/mbt-gates");
  await expect(page.getByRole("heading", { name: "Feature gates" })).toBeVisible();
  await expect(page.getByText("Live customer synchronization remains closed during local testing.")).toBeVisible();
  await page.getByLabel("Audit reason for your next change").fill("Open the local pilot gate");
  await page.getByRole("button", { name: "Turn on Local master data" }).click();
  await expect(page.locator("[data-flag-key='mbt_master_data']")).toContainText("Configured on");

  await page.getByLabel("Audit reason for your next change").fill("Close the local pilot gate");
  await page.getByRole("button", { name: "Turn off Local master data" }).click();
  await expect(page.locator("[data-flag-key='mbt_master_data']")).toContainText("Configured off");
  expect(commands).toHaveLength(2);
  expect(commands.map(({ path, body }) => [path, body.enabled, body.expectedRevision])).toEqual([
    ["/api/mbt/config/gates/mbt_master_data", true, 7],
    ["/api/mbt/config/gates/mbt_master_data", false, 8]
  ]);
  for (const command of commands) {
    expect(command.idempotencyKey).toMatch(/^mbt-admin-gate-mbt_master_data-/);
    expect(command.body.reason).toMatch(/local pilot gate/);
  }
});

test("F02/F15: Front Desk and Billing render their role-scoped disabled surfaces", async ({ page, request }) => {
  for (const fixture of [
    {
      role: "mbt_frontdesk",
      path: "/mbt/frontdesk",
      title: "Front Desk",
      status: "#frontdeskMessage",
      statusText: "This MBT capability is disabled.",
      commandSelector: [
        "#quoteForm input",
        "#quoteForm select",
        "#quoteForm textarea",
        "#quoteForm button",
        "#customerChargeForm input",
        "#customerChargeForm select",
        "#customerChargeForm textarea",
        "#customerChargeForm button"
      ].join(", ")
    },
    {
      role: "mbt_billing",
      path: "/mbt/billing",
      title: "Reconcile, calculate, approve locally",
      status: "#billingCommandMessage",
      statusText: "Commands are closed; retained evidence is available read-only. No external posting path exists.",
      commandSelector: ".mbt-command"
    }
  ]) {
    await openAs(page, request, fixture.role, fixture.path);
    await expect(page).toHaveURL(new RegExp(`${fixture.path.replace("/", "\\/")}$`));
    await expect(page.getByRole("heading", { name: fixture.title })).toBeVisible();
    await expect(page.locator(fixture.status)).toHaveText(fixture.statusText);
    const commands = page.locator(fixture.commandSelector);
    expect(await commands.count()).toBeGreaterThan(0);
    expect(await commands.evaluateAll((controls) => controls.every((control) => control.disabled))).toBe(true);
    await expect(page.getByRole("button", { name: /post|create sales order|create deposit/i })).toHaveCount(0);
  }
});

test("F01/F13/F15: Admin sees locked operations and only Phase 2 readiness controls", async ({ page, request }) => {
  await openAs(page, request, "admin", "/mbt/config");
  await expect(page.getByRole("heading", { name: "Configuration is safely locked" })).toBeVisible();
  await expect(page.locator(".mbt-status")).toContainText("operational safety gates are closed");
  await expect(page.locator(".mbt-status")).toContainText("no NetSuite operational write is available");
  const futureSetup = page.getByRole("tab", { name: "Future NetSuite Setup" });
  await expect(futureSetup).toBeVisible();
  await futureSetup.click();
  await expect(page.getByRole("button", { name: "Run read-only preflight" })).toBeVisible();
  await expect(page.getByRole("button", { name: /create contract|post|create sales order|create deposit/i })).toHaveCount(0);
});

test("F15: controlled shell has no serious or critical accessibility violations", async ({ page, request }) => {
  await openAs(page, request, "admin", "/mbt/config");
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
