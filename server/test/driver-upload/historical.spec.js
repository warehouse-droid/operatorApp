import crypto from "node:crypto";
import fs from "node:fs";
import sharp from "sharp";
import {expect, test} from "../support/driver-upload-browser-fixture.mjs";
import {query} from "../../src/db.js";
import {getDriverDayJobs} from "../../src/driver-repository.js";
import {driverCompanyDate} from "../../src/driver-plan-date-policy.js";

const history = JSON.parse(fs.readFileSync(new URL("../fixtures/driver-upload-history.json", import.meta.url), "utf8"));
const cases = history.plans.flatMap(source => {
  const drivers = new Set(source.trucks.flatMap(truck => (truck.loads || []).map(load => load.driverLogin || truck.driverLogin || load.driver || truck.driver).filter(Boolean)));
  return [...drivers].map(driver => ({source, driver}));
});
let seeded;
let image;
let executionPlanId;
const sourceSnapshots = new Map();
let activeSourceDate = "";

test.beforeAll(async ({browserName}) => {
  expect(process.env.MBT_TEST_ISOLATED).toBe("1");
  expect(process.env.DATABASE_URL).toMatch(/\/mbt_test(?:\?|$)/u);
  const sourcePrefix = `r${browserName[0]}${crypto.randomUUID().slice(0, 4)}`;
  seeded = new Map();
  const executedDate = driverCompanyDate();

  for (const source of history.plans) {
    const plan = structuredClone(source);
    const logins = new Set(cases.filter(entry => entry.source === source).map(entry => entry.driver));
    const tag = `${sourcePrefix}-${source.planDate.replaceAll("-", "")}`;
    const rename = new Map([...logins].map(login => [login, `${tag}-${login}`]));
    const orderRefs = new Set(plan.orders.flatMap(order => [order.id, ...(order.directPickupManifest || []).map(item => item.transferOrderRef)]).filter(Boolean));
    for (const ref of orderRefs) {
      const original = String(ref);
      const prefix = original.match(/^[A-Z]+/u)?.[0] || "HIST";
      const digits = (BigInt(`0x${crypto.createHash("sha256").update(`${tag}:${original}`).digest("hex").slice(0, 16)}`) % 100000000n).toString().padStart(8, "0");
      rename.set(original, `${prefix}${digits}`);
    }
    for (const truck of plan.trucks) {
      rename.set(String(truck.id), `T-${crypto.createHash("sha256").update(`${tag}:${truck.id}`).digest("hex").slice(0, 10)}`);
      if (truck.plate) rename.set(truck.plate, `HIST-${crypto.createHash("sha256").update(`${tag}:${truck.plate}`).digest("hex").slice(0, 10)}`);
      for (const load of truck.loads || []) {
        rename.set(String(load.id), `L-${crypto.createHash("sha256").update(`${tag}:${load.id}`).digest("hex").slice(0, 18)}`);
        for (const stop of load.stops || []) rename.set(String(stop.id), `S-${crypto.createHash("sha256").update(`${tag}:${stop.id}`).digest("hex").slice(0, 22)}`);
      }
    }
    function replace(value) {
      if (typeof value === "string") return rename.get(value) || value;
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      return value;
    }
    const transformed = replace(plan);
    sourceSnapshots.set(source.planDate, transformed);
    for (const original of logins) {
      const login = rename.get(original);
      await query("INSERT INTO dispatch_drivers (name, login, active, samsara_enabled) VALUES ($1, $1, true, false)", [login]);
      seeded.set(`${source.planDate}:${original}`, {login, executedDate});
    }
  }
  const inserted = await query("INSERT INTO dispatch_plans (plan_date, status, revision, note, confirmed_at) VALUES ($1, 'confirmed', 1, $2, now()) ON CONFLICT (plan_date) DO UPDATE SET revision = dispatch_plans.revision + 1, note = EXCLUDED.note RETURNING id", [executedDate, `driver-upload-history:${browserName}`]);
  executionPlanId = inserted.rows[0].id;
  await query("UPDATE mbt_feature_flags SET enabled = false, revision = revision + 1 WHERE flag_key = 'driver_offline_mode'");
  image = await sharp({create: {width: 180, height: 180, channels: 3, background: {r: 38, g: 110, b: 104}}}).jpeg().toBuffer();
});

async function nextJob(page, token, deviceId) {
  const response = await page.request.get("/api/driver/next-job", {headers: {authorization: `Bearer ${token}`, "x-mbbs-driver-device": deviceId, "x-mbbs-driver-version": "2026.08.12.3"}});
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function preparePage(page, login) {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {configurable: true, get: () => true}));
  await page.goto("/driver");
  await page.locator("#driverLogin").fill(login);
  const signedIn = page.waitForResponse(response => response.url().endsWith("/api/driver/login") && response.request().method() === "POST");
  await page.locator('[data-form="login"] button[type="submit"]').click();
  const response = await signedIn;
  expect(response.status(), await response.text()).toBe(200);
  return {token: (await response.json()).token, deviceId: response.request().headers()["x-mbbs-driver-device"]};
}

async function seedDirectPickupDependencies(snapshot, executedDate) {
  for (const order of snapshot.orders) {
    for (const manifest of order.directPickupManifest || []) {
      const salesId = Number(BigInt(`0x${crypto.createHash("sha256").update(order.id).digest("hex").slice(0, 12)}`));
      const transferId = Number(BigInt(`0x${crypto.createHash("sha256").update(manifest.transferOrderRef).digest("hex").slice(0, 12)}`));
      await query("INSERT INTO sales_orders (netsuite_id, tranid, status, netsuite_active, is_test_fixture) VALUES ($1, $2, 'B', true, true) ON CONFLICT DO NOTHING", [salesId, order.id]);
      await query("INSERT INTO transfer_orders (netsuite_id, tranid, status, from_location_id, from_location, to_location_id, to_location, netsuite_active) VALUES ($1, $2, 'B', $3, $4, 15, '12441', true) ON CONFLICT DO NOTHING", [transferId, manifest.transferOrderRef, Number(manifest.locationId) || 1, manifest.location]);
      const dependency = await query(`INSERT INTO order_dependencies (sales_order_id, sales_order_ref, transfer_order_id, transfer_order_ref,
        dependency_mode, same_load_required, status, source_location_id, source_location, accounting_destination_location_id,
        planned_plan_id, planned_date, dispatch_target_ref, dispatch_target_kind)
        VALUES ($1, $2, $3, $4, 'direct_to_customer', true, 'active', $5, $6, 15, $7, $8, $2, 'normal') RETURNING id`,
      [salesId, order.id, transferId, manifest.transferOrderRef, Number(manifest.locationId) || 1, manifest.location, executionPlanId, executedDate]);
      for (const [index, item] of (manifest.items || []).entries()) {
        const salesLine = await query("INSERT INTO sales_order_lines (sales_order_id, line_id, item_id, item_name, quantity, unit, netsuite_active) VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id", [salesId, index + 1, item.itemId, item.itemName, item.quantity, item.unit]);
        await query(`INSERT INTO order_dependency_lines (dependency_id, sales_line_id, item_id, item_name, unit, allocated_quantity,
          pallet_qty, layer_qty, section_qty, piece_qty) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [dependency.rows[0].id, salesLine.rows[0].id, item.itemId, item.itemName, item.unit, item.quantity, item.palletQty || 0, item.layerQty || 0, item.sectionQty || 0, item.pieceQty || 0]);
      }
    }
  }
}

for (const entry of cases) {
  test(`${entry.source.planDate} ${entry.driver}: complete the entire historical route with photo evidence`, async ({page}, testInfo) => {
    if (activeSourceDate !== entry.source.planDate) {
      const snapshot = sourceSnapshots.get(entry.source.planDate);
      await query(`INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, schema_version, plan_digest, order_count, truck_count, load_count, stop_count)
        VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 2, $5, $6, $7, $8, $9)
        ON CONFLICT (plan_id) DO UPDATE SET orders = EXCLUDED.orders, trucks = EXCLUDED.trucks, summary = EXCLUDED.summary,
          plan_digest = EXCLUDED.plan_digest, order_count = EXCLUDED.order_count, truck_count = EXCLUDED.truck_count,
          load_count = EXCLUDED.load_count, stop_count = EXCLUDED.stop_count`, [executionPlanId, JSON.stringify(snapshot.orders), JSON.stringify(snapshot.trucks), JSON.stringify(snapshot.summary), `driver-upload-history:${entry.source.planDate}`, snapshot.orders.length, snapshot.trucks.length, snapshot.trucks.flatMap(truck => truck.loads || []).length, snapshot.trucks.flatMap(truck => (truck.loads || []).flatMap(load => load.stops || [])).length]);
      await query("UPDATE dispatch_plans SET revision = revision + 1 WHERE id = $1", [executionPlanId]);
      await seedDirectPickupDependencies(snapshot, driverCompanyDate());
      activeSourceDate = entry.source.planDate;
    }
    const {login, executedDate} = seeded.get(`${entry.source.planDate}:${entry.driver}`);
    const initial = await getDriverDayJobs(login, {date: executedDate});
    const expectedIds = initial.jobs.map(job => job.jobId);
    expect(expectedIds.length).toBeGreaterThan(0);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const pending = new Set();
    let lastActivity = Date.now();
    page.on("request", request => {
      if (request.url().includes("/api/driver/") || request.url().includes("upload:3999")) {
        pending.add(request);
        lastActivity = Date.now();
      }
    });
    const finishRequest = request => {
      if (pending.delete(request)) lastActivity = Date.now();
    };
    page.on("requestfinished", finishRequest);
    page.on("requestfailed", finishRequest);
    page.on("response", response => finishRequest(response.request()));
    const reloadSettled = async () => {
      await expect.poll(() => ({pending: pending.size, quiet: Date.now() - lastActivity >= 200})).toEqual({pending: 0, quiet: true});
      await page.reload();
    };
    const {token, deviceId} = await preparePage(page, login);
    const completed = new Set();
    let photos = 0;
    const actions = [];
    for (let step = 0; step <= expectedIds.length; step += 1) {
      const result = await nextJob(page, token, deviceId);
      const job = result.job;
      if (!job) { expect(result.state.allJobsComplete).toBe(true); break; }
      expect(expectedIds).toContain(job.jobId);
      expect(completed.has(job.jobId)).toBe(false);
      await expect(page.locator(".job-panel")).toBeVisible();
      if (job.stopType === "truck_switch") {
        await page.locator('[data-action="confirm-truck-switch"]').click();
        await expect.poll(async () => (await nextJob(page, token, deviceId)).job?.jobId).not.toBe(job.jobId);
      } else {
        if (job.status !== "in_progress") {
          await page.locator('[data-action="start-job"]').click();
          await expect.poll(async () => (await nextJob(page, token, deviceId)).job?.status).toBe("in_progress");
        }
        await query("UPDATE driver_job_records SET started_at = now() - interval '11 seconds' WHERE lower(driver_login) = $1 AND status = 'in_progress'", [login]);
        await page.locator('[data-action="refresh"]').last().click();
        await expect.poll(async () => (await nextJob(page, token, deviceId)).job?.jobId).toBe(job.jobId);
        await expect(page.locator(".job-panel")).toBeVisible();
        const override = page.locator('[data-action="override-location"]');
        if (await override.isVisible()) await override.click();
        if (Number(job.requiredPhotos) > 0) {
          await page.locator('[data-action="show-photo"]').click();
          const modal = page.locator(".photo-modal");
          await expect(modal).toBeVisible();
          for (let index = 0; index < Math.max(2, Number(job.requiredPhotos)); index += 1) {
            await modal.locator(`input[data-photo-index="${index}"][data-photo-source="gallery"]`).setInputFiles({name: `history-${index}.jpg`, mimeType: "image/jpeg", buffer: image});
            await expect(modal.locator(".photo-preview img")).toHaveCount(index + 1);
            photos += 1;
          }
        }
        const saved = page.waitForResponse(response => response.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`) && response.request().method() === "POST", {timeout: 20000});
        const button = page.locator('[data-action="complete-job"]').last();
        await expect(button).toBeEnabled();
        await button.click();
        const response = await saved;
        expect(response.status(), await response.text()).toBe(200);
      }
      const ids = job.physicalVisitJobIds?.length ? job.physicalVisitJobIds : [job.jobId];
      for (const id of ids) completed.add(id);
      const records = await query("SELECT job_id, status, photo_data_urls FROM driver_job_records WHERE job_id = ANY($1::text[])", [ids]);
      expect(records.rowCount).toBe(ids.length);
      for (const record of records.rows) {
        expect(record.status).toBe("complete");
        if (["pickup", "dropoff"].includes(job.stopType)) expect(record.photo_data_urls.length).toBeGreaterThanOrEqual(2);
      }
      actions.push({stopType: job.stopType, logicalJobs: ids.length});
      if (step === 0) await reloadSettled();
    }
    expect([...completed].sort()).toEqual([...expectedIds].sort());
    expect(errors).toEqual([]);
    await testInfo.attach("historical-coverage", {contentType: "application/json", body: JSON.stringify({sourceDate: entry.source.planDate, executedDate, sourceDriver: entry.driver, logicalJobs: completed.size, photos, actions})});
  });
}
