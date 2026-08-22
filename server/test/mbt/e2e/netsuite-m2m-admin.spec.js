import crypto from "node:crypto";

import { expect, test } from "./mbt-e2e-test.js";

import { createOperator } from "../../../src/auth-repository.js";
import { query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().slice(0, 8);
const USERNAME = `m2m-e2e-admin-${RUN_ID}`;
const PASSWORD = "p3-m2m-browser-admin-password";
const RECOVERY_PASSPHRASE = "M2M browser recovery test 2026";

async function removeFixture() {
  await query(
    "DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operators WHERE username = $1)",
    [USERNAME]
  );
  await query("DELETE FROM operators WHERE username = $1", [USERNAME]);
}

async function login(request) {
  const response = await request.post("/api/auth/login", {
    data: { username: USERNAME, password: PASSWORD }
  });
  expect(response.status()).toBe(200);
  return (await response.json()).token;
}

test.beforeAll(async () => {
  await removeFixture();
  await createOperator({
    username: USERNAME,
    displayName: "NetSuite M2M browser Admin",
    password: PASSWORD,
    role: "admin",
    roles: ["admin"]
  });
});

test.afterAll(async () => {
  await removeFixture().catch(() => null);
});

test("Admin can inspect staged M2M setup and download only its public certificate", async ({ page, request }) => {
  const token = await login(request);
  const generated = await request.post("/api/admin/netsuite-m2m/certificates", {
    headers: { authorization: `Bearer ${token}` },
    data: {
      commonName: "MBBS NetSuite M2M browser test",
      recoveryPassphrase: RECOVERY_PASSPHRASE
    }
  });
  expect(generated.status()).toBe(201);
  expect(generated.headers()["cache-control"]).toContain("no-store");
  const generatedPayload = await generated.json();
  expect(generatedPayload.publicCertificatePem).toContain("BEGIN CERTIFICATE");
  expect(generatedPayload.recoveryPrivateKeyPem).toContain("BEGIN ENCRYPTED PRIVATE KEY");

  await page.goto("/");
  await page.evaluate((value) => {
    globalThis.localStorage.setItem("mbbs.staff.token", value);
    globalThis.localStorage.setItem("mbbs.staff.role", "admin");
    globalThis.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
    globalThis.localStorage.setItem("mbbs.control.token", value);
  }, token);
  await page.goto("/admin/sync");

  const panel = page.locator(".netsuite-m2m-panel");
  await expect(panel.getByRole("heading", { name: "NetSuite Machine-to-Machine Authentication" })).toBeVisible();
  await expect(panel).toContainText("Access tokens are renewed automatically before expiry");
  await expect(panel).toContainText("the existing webhook remains the automatic order-status trigger");
  await expect(panel).toContainText("Browser OAuth fallback");
  await expect(panel).toContainText(generatedPayload.status.staged.fingerprint256);

  await expect(panel.getByRole("button", { name: "Generate staged certificate" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Download public certificate" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Test and activate M2M" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Reconcile Pending Approval now" })).toBeEnabled();
  await expect(panel.locator('[data-field="m2m-recovery-passphrase"]')).toHaveAttribute("autocomplete", "new-password");
  await expect(panel.locator('[data-field="m2m-recovery-passphrase"]')).toHaveValue("");

  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download public certificate" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/public\.pem$/u);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) {chunks.push(chunk);}
  const contents = Buffer.concat(chunks).toString("utf8");
  expect(contents).toContain("BEGIN CERTIFICATE");
  expect(contents).not.toContain("PRIVATE KEY");
});
