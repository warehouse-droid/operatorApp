import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../../public/control.js", import.meta.url), "utf8");
const start = source.indexOf("function mapsUsageActionLabel(");
const end = source.indexOf("function renderDashboardSection(", start);
const implementation = source.slice(start, end);
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const fixture = {
  rolling30Day: 651, hardLimit: 4_500, remaining: 3_849, mode: "normal",
  dailyCapacity: { day: "2026-09-22", used: 63, baseLimit: 150, extraUnits: 0, limit: 150,
    remaining: 87, reopenUnits: 150, canReopen: false, resetsAt: "2026-09-23T00:00:00.000Z" },
  perSubsystem: { dynamic_map: 300, driver_geocode: 243, dispatch_route: 103, support_route: 5 },
  daily: [{ day: "2026-09-22", admittedUnits: 63, attemptedUnits: 66, deniedCount: 3, failedCount: 0 }],
  actions: [
    { subsystem: "dynamic_map", reason: "browser_page_load", admittedUnits: 261 },
    { subsystem: "driver_geocode", reason: "driver_location_check", admittedUnits: 243 },
    { subsystem: "dynamic_map", reason: "manual_refresh", admittedUnits: 39 }
  ]
};

function render(usage = fixture, admin = true) {
  return Function("mapsUsage", "operator", "hasStaffAuthority", "escapeHtml", "mapsDailyReopenBusy",
    `${implementation}; return renderMapsUsageSection();`)(usage, {}, () => admin, escapeHtml, false);
}

test("Maps Usage shows today's used/limit, remaining, UTC reset, and the real overall period", () => {
  const html = render();
  assert.match(html, /63\s*\/\s*150/u);
  assert.match(html, /42%/u);
  assert.match(html, /87 remaining/u);
  assert.match(html, /00:00 UTC/u);
  assert.match(html, /651\s*\/\s*4,500/u);
  assert.match(html, /rolling 30 days/u);
});

test("the highest-usage feature combines automatic and manual maps and labels them correctly", () => {
  const html = render();
  assert.match(html, /Highest usage feature/u);
  assert.match(html, /Embedded map displays/u);
  assert.match(html, /300 admitted/u);
  assert.match(html, /Manual map display/u);
  assert.ok(html.indexOf("Embedded map displays") < html.indexOf("Driver address checks"));
});

test("the reopen button is available only for an exhausted daily allowance and explains its scope", () => {
  const html = render({ ...fixture, dailyCapacity: { ...fixture.dailyCapacity, used: 150, remaining: 0, canReopen: true } });
  assert.match(html, /data-action="reopen-maps-daily-capacity"(?![^>]*disabled)/u);
  assert.match(html, /Reopen daily capacity/u);
  assert.match(html, /150.*UTC day/u);
  assert.match(render(), /data-action="reopen-maps-daily-capacity"[^>]*disabled/u);
  assert.equal(render(fixture, false), "");
});

test("empty or unavailable usage does not invent a current daily count or enable reopening", () => {
  const html = render({ error: "<offline>", daily: [], actions: [] });
  assert.match(html, /&lt;offline>/u);
  assert.doesNotMatch(html, /undefined|NaN/u);
  assert.match(html, /data-action="reopen-maps-daily-capacity"[^>]*disabled/u);
});

function client(request, initial = { ...fixture, dailyCapacity: { ...fixture.dailyCapacity, used: 150, remaining: 0, canReopen: true } }) {
  return Function("request", "crypto", "initial", `
    let mapsUsage = initial, mapsDailyReopenBusy = false, mapsDailyReopenRequest = null;
    const render = () => {};
    ${implementation}
    return { reopen: reopenMapsDailyCapacity, busy: () => mapsDailyReopenBusy,
      usage: () => mapsUsage, update: value => { mapsUsage = value; } };
  `)(request, { randomUUID: () => "a-test-request-id" }, initial);
}

test("reopening prevents duplicate clicks and reuses its ID after a lost response", async () => {
  const requests = [];
  let release;
  const ui = client(async (_path, input) => {
    requests.push(JSON.parse(input.body));
    await new Promise((resolve) => { release = resolve; });
    if (requests.length === 1) throw new Error("Lost response");
    return { ...fixture, dailyCapacity: { ...fixture.dailyCapacity, limit: 300 } };
  });
  const first = ui.reopen();
  assert.equal(ui.busy(), true);
  await ui.reopen();
  assert.equal(requests.length, 1);
  release();
  await assert.rejects(first, /Lost response/u);
  assert.equal(ui.busy(), false);
  const second = ui.reopen();
  release();
  await second;
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[0].expectedLimit, 150);
  assert.equal(ui.usage().dailyCapacity.limit, 300);
});

test("refreshing after another admin reopens uses the new capacity revision", async () => {
  const requests = [];
  const ui = client(async (_path, input) => {
    requests.push(JSON.parse(input.body));
    throw new Error("Capacity changed");
  });
  await assert.rejects(ui.reopen());
  ui.update({ ...fixture, dailyCapacity: { ...fixture.dailyCapacity, used: 300, limit: 300, canReopen: true } });
  await assert.rejects(ui.reopen());
  assert.equal(requests[1].expectedLimit, 300);
});
