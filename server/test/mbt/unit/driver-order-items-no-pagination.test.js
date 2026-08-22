import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const driverSource = read("../../../public/driver.js");
const driverCss = read("../../../public/driver.css");

function sourceBetween(startMarker, endMarker) {
  const start = driverSource.indexOf(startMarker);
  const end = driverSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source was not found.`);
  return driverSource.slice(start, end);
}

test("Driver renders every item from a long order before the following order", () => {
  const renderOrders = Function(
    "escapeHtml",
    "t",
    "unitPills",
    `"use strict"; ${sourceBetween("function renderOrders(job)", "function deliveryInstructionImageEntries(job)")}; return renderOrders;`
  )(
    (value) => String(value ?? ""),
    (_key, fallback) => fallback,
    (units) => (units || []).map((unit) => `${unit.value} ${unit.unit}`).join(" ")
  );

  const firstItems = Array.from({ length: 8 }, (_value, index) => ({
    itemName: `Long order item ${index + 1}`,
    units: [{ value: index + 1, unit: "EA" }]
  }));
  const html = renderOrders({
    orders: [
      { orderRef: "SO-LONG", items: firstItems },
      { orderRef: "SO-NEXT", items: [{ itemName: "Following order item", units: [] }] }
    ]
  });

  for (const item of firstItems) {
    assert.match(html, new RegExp(item.itemName));
  }
  assert.match(html, /Following order item/);
  assert.ok(html.indexOf("Long order item 8") < html.indexOf("SO-NEXT"));
  assert.equal((html.match(/<section class="order-card">/g) || []).length, 2);
  assert.doesNotMatch(html, /data-action="(?:order-page|stop-detail-page)"/);
});

test("drop-off instructions and all orders share one vertically scrolling stop detail", () => {
  const renderStopDetails = Function(
    "renderOrders",
    "renderDeliveryInstructionPage",
    `"use strict"; ${sourceBetween("function renderStopDetails(job)", "function renderLocationCheck(job)")}; return renderStopDetails;`
  )(
    () => "<section>ALL ORDER ITEMS</section>",
    () => "<section>DELIVERY INSTRUCTIONS</section>"
  );

  const html = renderStopDetails({ stopType: "dropoff" });
  assert.ok(html.indexOf("DELIVERY INSTRUCTIONS") < html.indexOf("ALL ORDER ITEMS"));
  assert.match(html, /class="stop-detail-page"/);
  assert.doesNotMatch(html, /(?:Previous|Next|order-pager|stop-detail-pager)/);
  assert.match(driverCss, /\.driver-content\s*\{[\s\S]*?overflow-y:\s*auto;/);
});

test("Driver item pagination state and click actions have been removed", () => {
  assert.doesNotMatch(driverSource, /ITEMS_PER_PAGE|orderPages|driverStopItemPages|renderDriverStopItemPage/);
  assert.doesNotMatch(driverSource, /data-action=["'](?:order-page|stop-detail-page)["']/);
  assert.doesNotMatch(driverSource, /action === ["'](?:order-page|stop-detail-page)["']/);
  assert.doesNotMatch(driverCss, /\.order-pager|\.stop-detail-pager/);
});
