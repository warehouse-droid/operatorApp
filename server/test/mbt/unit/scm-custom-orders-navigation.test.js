import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [menu, sidebar, page, html, server] = await Promise.all([
  "../../../public/scm-menu.html",
  "../../../public/app-sidebar.js",
  "../../../public/dispatch-custom-orders.js",
  "../../../public/dispatch-custom-orders.html",
  "../../../src/server.js"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

test("SCM exposes Custom Orders only to SCM writers through an SCM-native route", () => {
  assert.match(
    menu,
    /\$\{canEdit \? `<button class="dispatch-menu-card[^`]+location\.href='\/scm\/custom-orders'[^`]+<strong>Custom Orders<\/strong>/s
  );
  assert.match(
    sidebar,
    /\{ label: "Custom Orders", href: "\/scm\/custom-orders", icon: "CU", scmWriteOnly: true, authorities: \["admin", "scm", "scm_staff"\] \}/
  );
  assert.match(server, /app\.get\("\/scm\/custom-orders",[\s\S]{0,120}dispatch-custom-orders\.html/);
  assert.ok(server.includes('"/scm/custom-orders"'), "The SCM page alias must receive the no-store application-page policy.");
});

test("the shared frontend selects an SCM API and SCM navigation without exposing Dispatch Planning", () => {
  assert.match(page, /const customOrdersScmMode = window\.location\.pathname\.startsWith\("\/scm\/"\)/);
  assert.match(
    page,
    /const customOrdersApiBase = customOrdersScmMode\s*\? "\/api\/scm\/custom-orders"\s*: "\/api\/dispatch\/custom-orders"/
  );
  assert.match(page, /customOrdersScmMode \? "\/scm" : "\/dispatch"/);
  assert.match(page, /customOrdersScmMode \? \["admin", "scm", "scm_staff"\] : \["dispatcher", "admin"\]/);
  assert.match(page, /\$\{customOrdersScmMode \? "" : `<button data-action="go-planning"/);
  assert.match(html, /dispatch-custom-orders\.js\?v=20260819-scm-menu-v1/);
});

test("SCM Custom Order CRUD is separately authorized while Dispatch authorization stays unchanged", () => {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const suffix = ["put", "patch", "delete"].includes(method) ? "\\/:id" : "";
    assert.match(
      server,
      new RegExp(`app\\.${method}\\(\\"\\/api\\/scm\\/custom-orders${suffix}\\", requireSmartScmWriteAccess`),
      `${method.toUpperCase()} SCM Custom Orders must require SCM write authority.`
    );
  }
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const suffix = ["put", "patch", "delete"].includes(method) ? "\\/:id" : "";
    assert.match(
      server,
      new RegExp(`app\\.${method}\\(\\"\\/api\\/dispatch\\/custom-orders${suffix}\\", requireDispatcher`),
      `${method.toUpperCase()} Dispatch Custom Orders must remain dispatcher-authorized.`
    );
  }
});
