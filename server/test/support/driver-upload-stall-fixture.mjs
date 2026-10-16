import crypto from "node:crypto";
import sharp from "sharp";
import {expect} from "@playwright/test";
import {query} from "../../src/db.js";
import {driverCompanyDate} from "../../src/driver-plan-date-policy.js";
import {ce94489Replay} from "./dispatch-map-driver-replay-fixture.mjs";

async function addFixturePhotos(page) {
  await page.locator('[data-action="show-photo"]').click();
  const bytes = await sharp({create: {width: 120, height: 120, channels: 3, background: {r: 25, g: 125, b: 115}}}).jpeg().toBuffer();
  for (let index = 0; index < 2; index += 1) {
    await page.locator(`.photo-modal input[data-photo-index="${index}"][data-photo-source="gallery"]`).setInputFiles({name: `fault-${index}.jpg`, mimeType: "image/jpeg", buffer: bytes});
    await expect(page.locator(".photo-preview img")).toHaveCount(index + 1);
  }
}

export async function readyGroupedDropoff(page, browserName, {withNext = false} = {}) {
  expect(process.env.MBT_TEST_ISOLATED).toBe("1");
  const suffix = crypto.randomUUID().slice(0, 8);
  const login = `fault-${browserName}-${suffix}`;
  const source = structuredClone(ce94489Replay.plan);
  const order = source.orders[0];
  order.id = `SN${Math.floor(Math.random() * 90000000 + 10000000)}`;
  order.type = "SO";
  order.sourceYard = "3445";
  order.sourceAddress = "3445 Kennedy Road, Toronto, ON";
  order.pickupLocations = ["3445"];
  order.address = "279 Darcy St, Oshawa, ON L1G 6W6";
  order.destinationYard = order.address;
  order.customer = "Synthetic grouped delivery";
  const children = [0, 1].map(index => ({...order, id: `SOFIX${suffix.replace(/[^0-9]/gu, "")}0${index}`}));
  order.id = `GOB-FIX-${suffix}`;
  order.childOrders = children.map(child => child.id);
  order.childOrderDetails = children;
  const loadId = `fault-load-${suffix}`;
  const trucks = [{id: `fault-truck-${suffix}`, plate: `FIX-${suffix}`, base: "3445", driverLogin: login, driver: login,
    loads: [{id: loadId, name: "Fault test load", driverLogin: login, truckId: `fault-truck-${suffix}`, truckPlate: `FIX-${suffix}`,
      stops: [{id: `fault-pick-${suffix}`, type: "pick", orderId: order.id, loadId, location: order.sourceYard},
        {id: `fault-drop-${suffix}`, type: "drop", orderId: order.id, loadId, location: order.address, dropLocation: order.address, dropAddress: order.address}]}]}];
  if (withNext) {
    const nextLoad = structuredClone(trucks[0].loads[0]);
    nextLoad.id += '-next';
    nextLoad.stops = nextLoad.stops.map(stop => ({...stop, id: stop.id + '-next', loadId: nextLoad.id}));
    trucks[0].loads.push(nextLoad);
  }
  await query("INSERT INTO dispatch_drivers (name, login, active, samsara_enabled) VALUES ($1, $1, true, false)", [login]);
  const inserted = await query("INSERT INTO dispatch_plans (plan_date, status, revision, note, confirmed_at) VALUES ($1, 'confirmed', 1, 'upload-fault-tests', now()) ON CONFLICT (plan_date) DO UPDATE SET revision = dispatch_plans.revision + 1 RETURNING id", [driverCompanyDate()]);
  await query(`INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, schema_version, plan_digest, order_count, truck_count, load_count, stop_count)
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, 2, 'upload-fault-tests', 1, 1, 1, 2)
    ON CONFLICT (plan_id) DO UPDATE SET orders = dispatch_plan_snapshots.orders || EXCLUDED.orders,
      trucks = dispatch_plan_snapshots.trucks || EXCLUDED.trucks`, [inserted.rows[0].id, JSON.stringify([order]), JSON.stringify(trucks), JSON.stringify({ownYardCodes: ["3445", "2967"]})]);
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {configurable: true, get: () => true}));
  await page.goto("/driver");
  await page.locator("#driverLogin").fill(login);
  const signedIn = page.waitForResponse(response => response.url().endsWith("/api/driver/login"));
  await page.locator('[data-form="login"] button[type="submit"]').click();
  const signed = await signedIn;
  const token = (await signed.json()).token;
  const deviceId = signed.request().headers()["x-mbbs-driver-device"];
  const next = async () => {
    const response = await page.request.get("/api/driver/next-job", {headers: {authorization: `Bearer ${token}`, "x-mbbs-driver-device": deviceId, "x-mbbs-driver-version": "2026.08.12.3"}});
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  let job;
  for (let step = 0; step < 5; step += 1) {
    job = (await next()).job;
    expect(job).toBeTruthy();
    if (job.status !== "in_progress") {
      await page.locator('[data-action="start-job"]').click();
      await expect.poll(async () => (await next()).job?.status).toBe("in_progress");
    }
    await query("UPDATE driver_job_records SET started_at = now() - interval '11 seconds' WHERE lower(driver_login) = $1 AND status = 'in_progress'", [login]);
    await page.locator('[data-action="refresh"]').last().click();
    const override = page.locator('[data-action="override-location"]');
    if (await override.isVisible()) await override.click();
    if (Number(job.requiredPhotos) > 0 && job.stopType === "dropoff") break;
    if (Number(job.requiredPhotos) > 0) await addFixturePhotos(page);
    const response = page.waitForResponse(result => result.url().includes(`/jobs/${encodeURIComponent(job.jobId)}/photos`));
    await page.locator('[data-action="complete-job"]').last().click();
    expect((await response).status()).toBe(200);
  }
  expect(Number(job.requiredPhotos)).toBeGreaterThan(0);
  expect(job.stopType).toBe("dropoff");
  expect(job.orderRefs).toHaveLength(2);
  await addFixturePhotos(page);
  return {login, job, next};
}

