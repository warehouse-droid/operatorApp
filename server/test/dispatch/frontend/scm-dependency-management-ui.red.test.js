import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, source, css, server, sidebar, menu] = await Promise.all([
  "../../../public/scm-dependency-management.html",
  "../../../public/scm-dependency-management.js",
  "../../../public/scm-dependency-management.css",
  "../../../src/server.js",
  "../../../public/app-sidebar.js",
  "../../../public/scm-menu.html"
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

test("SCM Dependency Manager is navigable for SCM writers and read-only Dispatch", () => {
  assert.match(server, /app\.get\(["']\/scm\/dependency-management["']/u);
  assert.match(sidebar, /Dependency Manager[\s\S]{0,160}\/scm\/dependency-management/u);
  assert.match(menu, /\/scm\/dependency-management/u);
  assert.match(html, /scmDependencyManagementApp/u);
  assert.match(source, /roles:\s*\[[^\]]*"dispatcher"/u);
  assert.match(source, /canWriteDependencyManagement/u);
  assert.match(source, /read-only|read only/iu);
});

test("the manager uses indexed paging and loads current group/split line identity", () => {
  assert.match(source, /\/api\/scm\/dependency-management\/targets\?/u);
  assert.match(source, /nextCursor/u);
  assert.match(source, /AbortController/u);
  assert.match(source, /targetLineKey/u);
  assert.match(source, /sourceOrderRef/u);
  assert.match(source, /memberRefs/u);
  assert.match(source, /\/to-options/u);
  assert.match(source, /\/po-options/u);
});

test("TO, PO, mode, and unlink changes are always previewed before an explicit apply", () => {
  assert.match(source, /dependencyCommand\("link_to"/u);
  assert.match(source, /dependencyCommand\("link_po"/u);
  assert.match(source, /dependencyCommand\("change_mode"/u);
  assert.match(source, /dependencyCommand\("unlink_to"/u);
  assert.match(source, /dependencyCommand\("unlink_po"/u);
  assert.match(source, /\/preview/u);
  assert.match(source, /\/commit/u);
  assert.match(source, /crypto\.randomUUID/u);
  assert.match(source, /payloadHash/u);
  assert.match(source, /expectedPlanRevision/u);
  assert.match(source, /expectedPlanDigest/u);
  assert.match(source, /blockers/u);
});

test("suspended Driver routes remain pending until a human re-previews and applies", () => {
  assert.match(source, /waiting_driver/u);
  assert.match(source, /Re-preview/u);
  assert.match(source, /No plan data was changed|no plan data was changed/u);
  assert.doesNotMatch(source, /setInterval\([^)]*commit|autoApply|automaticallyApply/u);
});

test("the new page has a bounded, responsive two-pane workspace", () => {
  assert.match(css, /overflow-y:\s*auto/u);
  assert.match(css, /grid-template-columns/u);
  assert.match(css, /@media/u);
});
