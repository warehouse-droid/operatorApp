import { expect, test } from "./mbt-e2e-test.js";

import { OPERATOR_NETSUITE_GATE_DEFINITIONS } from "../../../src/operator-netsuite-posting-policy.js";

/* global localStorage, window */

test.use({ serviceWorkers: "block" });

const ORDER_ID = "9900771";
const ORDER = Object.freeze({
  netsuite_id: ORDER_ID,
  tranid: "SO-POSTING-E2E",
  order_type: "sales_order",
  delivery_method: "Pick-Up",
  customer: "Posting E2E customer",
  trandate: "2026-08-25",
  outbound_location_id: 15,
  outbound_location: "12441",
  operator_status: "packed",
  local_yard_order_status: "Packed",
  lines: [Object.freeze({
    id: "posting-e2e-line",
    line_id: "1",
    item_id: "77001",
    item_name: "Posting E2E item",
    sku: "POSTING-E2E",
    item_description: "Exact packed line",
    item_type: "InvtPart",
    quantity: 1,
    unit: "PC",
    piece_qty: 1,
    packed_piece_qty: 1,
    packed_pallet_qty: 0,
    packed_layer_qty: 0,
    packed_section_qty: 0,
    packed_sales_qty: 0,
    loaded_qty: 0,
    to_pcs: 1,
    netsuite_active: true,
    confirmed: true
  })]
});

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body)
  });
}

function postingPolicy({ effective, revision = 7 }) {
  return {
    schemaVersion: "operator-netsuite-posting-policy-v1",
    supported: true,
    gateKey: "operator_netsuite_customer_pickup_if_12441",
    functionKey: "customer_pickup",
    transactionType: "IF",
    locationId: 15,
    yardCode: "12441",
    present: true,
    configured: effective,
    environmentAllowed: true,
    effective,
    revision
  };
}

async function installOperatorSession(page) {
  await page.addInitScript(({ orderId }) => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("mbbs.staff.token", "operator-posting-e2e-token");
    localStorage.setItem("mbbs.operator.token", "operator-posting-e2e-token");
    localStorage.setItem("mbbs.operator.locationId", "15");
    localStorage.setItem("mbbs.operator.state", JSON.stringify({
      currentModule: "customer-pickup",
      locationId: 15,
      selectedId: orderId,
      selectedLineId: "posting-e2e-line"
    }));
  }, { orderId: ORDER_ID });
}

test("U1 gate-on Operator waits for verified NetSuite completion", async ({ page }) => {
  await installOperatorSession(page);
  const state = { completionBodies: [], polls: 0, unexpected: [] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {
      return json(route, { operator: { id: "posting-e2e-operator", display_name: "Posting E2E", role: "operator", roles: ["operator"] } });
    }
    if (pathname === "/api/delivery/notifications") {
      return json(route, { total: 0, salesOrder: { dueToday: 0 }, transferOrder: { dueToday: 0 }, items: [] });
    }
    if (pathname === "/api/delivery/current-draft") {return json(route, null);}
    if (pathname === `/api/delivery/orders/${ORDER_ID}`) {return json(route, ORDER);}
    if (pathname === "/api/customer-pickup/config") {
      return json(route, {
        schemaVersion: "operator-customer-pickup-photo-requirement-v1",
        flagKey: "operator_customer_pickup_photo_required",
        required: false,
        requiredPhotoCount: 0,
        revision: 3,
        updatedAt: "2026-08-25T00:00:00.000Z"
      });
    }
    if (pathname === "/api/operator/netsuite-posting-policy") {return json(route, postingPolicy({ effective: true }));}
    if (pathname === `/api/customer-pickup/orders/${ORDER_ID}/load` && request.method() === "POST") {
      state.completionBodies.push(request.postDataJSON());
      return json(route, {
        jobId: "posting-job-e2e",
        status: "running",
        posting: { schemaVersion: "operator-netsuite-posting-job-v1", status: "queued" }
      });
    }
    if (pathname === "/api/operator/netsuite-posting-jobs/posting-job-e2e") {
      state.polls += 1;
      return json(route, state.polls === 1
        ? {
            id: "posting-job-e2e",
            status: "posting",
            steps: [{ status: "posted", sourceOrderRef: "SO-POSTING-E2E", transactionRef: "IF-E2E" }]
          }
        : {
            id: "posting-job-e2e",
            status: "completed",
            steps: [{ status: "posted", sourceOrderRef: "SO-POSTING-E2E", transactionRef: "IF-E2E" }],
            result: {
              localFinalization: {
                id: 771,
                pickupStatus: "loaded",
                localYardOrderStatus: "loaded",
                remainingLines: 0,
                photoEvidenceCount: 0,
                operatorNetSuitePosting: {
                  transactions: [{
                    sourceOrderKind: "SO",
                    sourceOrderRef: "SO-POSTING-E2E",
                    transactionType: "IF",
                    transactionId: "7711",
                    transactionRef: "IF-E2E"
                  }]
                }
              }
            }
          });
    }
    state.unexpected.push(`${request.method()} ${pathname}`);
    return json(route, { error: `Unhandled ${request.method()} ${pathname}` }, 404);
  });

  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: "SO-POSTING-E2E", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.getByText("Creates NetSuite IF", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await expect(page.locator(".fulfillment-card.success").getByText("Loaded", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("IF IF-E2E", { exact: true })).toBeVisible();
  expect(state.polls).toBe(2);
  expect(state.completionBodies).toHaveLength(1);
  expect(state.completionBodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(state.completionBodies[0].netSuitePostingPolicy).toEqual({
    gateKey: "operator_netsuite_customer_pickup_if_12441",
    revision: 7,
    effective: true
  });
  expect(state.unexpected).toEqual([]);
});

function adminGate(definition) {
  return {
    ...definition,
    gateGroup: "operator_netsuite_posting",
    present: true,
    configured: false,
    environmentAllowed: true,
    effective: false,
    locked: false,
    revision: 1,
    updatedBy: null,
    updatedAt: null
  };
}

test("U2 Admin controls one matrix cell and safely resumes one attention command", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mbbs.staff.token", "posting-admin-e2e-token");
  });
  const gates = OPERATOR_NETSUITE_GATE_DEFINITIONS.map(adminGate);
  let attention = true;
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {return json(route, { operator: { role: "admin", roles: ["admin"] } });}
    if (pathname === "/api/mbt/config/gates" && request.method() === "GET") {
      return json(route, {
        schemaVersion: "mbt-admin-gates-v1",
        environmentRootAllowed: false,
        netSuiteDirectAccessAllowed: true,
        gates
      });
    }
    if (pathname.startsWith("/api/mbt/config/gates/") && request.method() === "PUT") {
      const key = decodeURIComponent(pathname.slice("/api/mbt/config/gates/".length));
      const gate = gates.find((candidate) => candidate.flagKey === key);
      const body = request.postDataJSON();
      calls.push({ path: pathname, body });
      gate.configured = body.enabled;
      gate.effective = body.enabled;
      gate.revision += 1;
      return json(route, { gate });
    }
    if (pathname === "/api/admin/operator-netsuite-posting/attention" && request.method() === "GET") {
      return json(route, {
        schemaVersion: "operator-netsuite-posting-attention-v1",
        commands: attention ? [{
          id: "attention-command-e2e",
          yardCode: "12441",
          functionKey: "delivery_prep",
          transactionType: "IF",
          status: "attention",
          lastError: "Transform response was lost.",
          steps: [{ sourceOrderRef: "SO-ATTENTION", status: "uncertain" }]
        }] : []
      });
    }
    if (pathname === "/api/admin/operator-netsuite-posting/attention-command-e2e/resume" && request.method() === "POST") {
      calls.push({ path: pathname, body: request.postDataJSON() });
      attention = false;
      return json(route, { command: { id: "attention-command-e2e", status: "queued" } });
    }
    return json(route, { error: `Unhandled ${request.method()} ${pathname}` }, 404);
  });

  await page.goto("/admin/mbt-gates");
  await expect(page.getByRole("heading", { name: "Operator NetSuite posting by yard" })).toBeVisible();
  await expect(page.locator(".mbt-operator-gate-table tbody tr")).toHaveCount(4);
  await expect(page.getByText("Transform response was lost.")).toBeVisible();

  await page.getByLabel("Audit reason for your next change").fill("Enable one verified 12441 function");
  await page.getByRole("button", { name: "Turn on 12441 delivery prep IF" }).click();
  await expect(page.getByText("Creates IF", { exact: true })).toBeVisible();

  await page.getByLabel("Audit reason for your next change").fill("Recover the lost response by external ID");
  await page.getByRole("button", { name: "Resume verification" }).click();
  await expect(page.getByText("No Operator NetSuite posting commands need attention.")).toBeVisible();
  expect(calls).toEqual([
    expect.objectContaining({
      path: "/api/mbt/config/gates/operator_netsuite_delivery_prep_if_12441",
      body: expect.objectContaining({ enabled: true, expectedRevision: 1 })
    }),
    {
      path: "/api/admin/operator-netsuite-posting/attention-command-e2e/resume",
      body: { reason: "Recover the lost response by external ID" }
    }
  ]);
});
