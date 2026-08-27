import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [controlSource, controlHtml, adminHtml] = await Promise.all([
  "../../../public/control.js",
  "../../../public/control.html",
  "../../../public/admin.html"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `Missing source boundary: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Yard In/Outbound incremental detail renders hydrate secure photo thumbnails", () => {
  const implementation = between(
    controlSource,
    "function replaceSecurePhotoHtml(element, html)",
    "async function downloadLoadedCsv()"
  );
  const calls = [];
  const element = (name) => ({
    name,
    set innerHTML(value) {
      calls.push(`${name}:html:${value}`);
    }
  });
  const elements = {
    loadedOrderList: element("list"),
    loadedDetailPanel: element("detail")
  };
  const refresh = Function(
    "document",
    "renderLoadedOrderList",
    "renderLoadedOrderDetail",
    "releaseSecurePhotoImages",
    "hydrateSecurePhotoImages",
    `${implementation}; return refreshLoadedPanels;`
  )(
    { getElementById: (id) => elements[id] || null },
    () => {
      calls.push("render:list");
      return "orders";
    },
    () => {
      calls.push("render:detail");
      return '<img data-secure-photo-ref="r2://driver/photo.jpg">';
    },
    (root) => calls.push(`${root.name}:release`),
    (root) => calls.push(`${root.name}:hydrate`)
  );

  refresh();

  assert.deepEqual(calls, [
    "render:list",
    "list:release",
    "list:html:orders",
    "list:hydrate",
    "render:detail",
    "detail:release",
    'detail:html:<img data-secure-photo-ref="r2://driver/photo.jpg">',
    "detail:hydrate"
  ]);
});

test("Control and Admin request the cache-busted thumbnail hydration client", () => {
  const expectedAsset = "/control.js?v=20260825-so-reattempt-current-item-v1";
  assert.ok(controlHtml.includes(expectedAsset));
  assert.ok(adminHtml.includes(expectedAsset));
});
