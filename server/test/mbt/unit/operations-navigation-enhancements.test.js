import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [operatorSource, operatorCss, operatorHtml, serviceWorker, dispatchCss, dispatchMenu, scmMenu, sidebarSource] = await Promise.all([
  "../../../public/operator.js",
  "../../../public/operator.css",
  "../../../public/operator.html",
  "../../../public/service-worker.js",
  "../../../public/dispatch.css",
  "../../../public/dispatch-menu.html",
  "../../../public/scm-menu.html",
  "../../../public/app-sidebar.js"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `Missing source boundary: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

function cssRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing CSS rule: ${selector}`);
  const end = source.indexOf("}", start);
  assert.ok(end > start, `Unclosed CSS rule: ${selector}`);
  return source.slice(start, end + 1);
}

function buildCycleHarness() {
  const implementation = between(
    operatorSource,
    "function currentCycleOptions()",
    "function renderCycleCountPanel(item)"
  );
  const optionPageSize = Number(operatorSource.match(/const CYCLE_OPTION_PAGE_SIZE = (\d+);/)?.[1]);
  const skuPageSize = Number(operatorSource.match(/const LINE_PAGE_SIZE = (\d+);/)?.[1]);
  assert.equal(optionPageSize, 6);
  assert.equal(skuPageSize, 3);

  return Function("CYCLE_OPTION_PAGE_SIZE", "LINE_PAGE_SIZE", `
    let cycleSearch = "";
    let cycleStep = "type";
    let cyclePage = 0;
    let inventoryItems = [];
    let selectedInventoryItem = null;
    const cycleFacets = {
      productTypes: Array.from({ length: 8 }, (_, index) => ({ value: "Type-" + (index + 1), count: index + 1 })),
      brands: [],
      series: []
    };
    const t = (_key, fallback) => fallback;
    const pageCount = (items, size) => Math.max(1, Math.ceil(items.length / size));
    const pageItems = (items, page, size) => items.slice(page * size, page * size + size);
    ${implementation}
    return {
      renderCycleMain,
      currentCyclePageCount,
      setPage(value) { cyclePage = value; },
      setSearch(value) { cycleSearch = value; },
      setInventory(value) { inventoryItems = value; }
    };
  `)(optionPageSize, skuPageSize);
}

function buildSidebarHarness() {
  const mainItems = between(sidebarSource, "const mainItems = [", "const dispatchItems = [");
  const roleFunctions = between(sidebarSource, "function staffRoleSet()", "function canManageScmPurchaseOrders()");
  const visibleMainItems = between(sidebarSource, "function visibleMainItems()", "function visibleMbtItems()");
  const values = new Map();
  const localStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    clear() {
      values.clear();
    }
  };
  const window = { MBBS_DISPATCH_OPERATOR: null };
  const harness = Function("window", "localStorage", `
    let sidebarOperator = null;
    ${mainItems}
    ${roleFunctions}
    ${visibleMainItems}
    return {
      visibleMainItems,
      setSidebarOperator(value) { sidebarOperator = value; }
    };
  `)(window, localStorage);
  return { ...harness, window, localStorage };
}

test("operation cycle-count facets paginate independently from the SKU result list", () => {
  const cycle = buildCycleHarness();
  const firstPage = cycle.renderCycleMain();
  assert.equal((firstPage.match(/data-action="cycle-select"/g) || []).length, 6);
  assert.match(firstPage, /Type-1/);
  assert.match(firstPage, /Type-6/);
  assert.doesNotMatch(firstPage, /Type-7/);
  assert.match(firstPage, />1 \/ 2</);
  assert.equal(cycle.currentCyclePageCount(), 2);

  cycle.setPage(1);
  const secondPage = cycle.renderCycleMain();
  assert.equal((secondPage.match(/data-action="cycle-select"/g) || []).length, 2);
  assert.match(secondPage, /Type-7/);
  assert.match(secondPage, /Type-8/);
  assert.doesNotMatch(secondPage, /Type-1/);
  assert.match(secondPage, />2 \/ 2</);

  cycle.setSearch("sku");
  cycle.setInventory(Array.from({ length: 7 }, (_, index) => ({ item_id: index + 1 })));
  assert.equal(cycle.currentCyclePageCount(), 3, "SKU searches must retain their existing three-row pagination.");
  assert.match(operatorSource, /cyclePage = Math\.min\(currentCyclePageCount\(\) - 1, cyclePage \+ 1\)/);
  assert.match(cssRule(operatorCss, ".cycle-option-pagination"), /padding:\s*0 10px 10px/);
});

test("operator cache assets advance with the cycle-count pagination release", () => {
  for (const asset of [
    "/operator.css?v=20260810-operator-performance-v1",
    "/operator.js?v=20260815-customer-pickup-photo-gate-v1"
  ]) {
    assert.ok(operatorHtml.includes(asset));
    assert.ok(serviceWorker.includes(asset));
  }
  assert.ok(serviceWorker.includes("mbbs-yard-operator-v140-customer-pickup-photo-gate-v1"));
});

test("Dispatch and SCM card menus scroll within the fixed-height application shell", () => {
  const shellRule = cssRule(dispatchCss, ".dispatch-menu-shell");
  const pageRule = cssRule(dispatchCss, ".dispatch-menu-page");
  const gridRule = cssRule(dispatchCss, ".dispatch-menu-grid");
  assert.match(shellRule, /overflow:\s*hidden/);
  assert.match(pageRule, /grid-template-rows:\s*auto auto/);
  assert.match(pageRule, /overflow-y:\s*auto/);
  assert.match(pageRule, /overscroll-behavior:\s*contain/);
  assert.match(gridRule, /min-height:\s*max-content/);
  for (const menu of [dispatchMenu, scmMenu]) {
    assert.ok(menu.includes('class="dispatch-shell dispatch-menu-shell"'));
    assert.ok(menu.includes('class="dispatch-menu-page"'));
    assert.ok(menu.includes('/dispatch.css?v=20260810-scrollable-menu-v1'));
  }
});

test("main sidebar modules follow live primary and secondary authorities on every module path", () => {
  const sidebar = buildSidebarHarness();
  const hrefs = () => sidebar.visibleMainItems().map((item) => item.href);

  sidebar.window.MBBS_DISPATCH_OPERATOR = { role: "admin", roles: ["admin"] };
  assert.deepEqual(hrefs(), ["/admin", "/control", "/dispatch", "/scm", "/sales", "/mbt", "/operator"]);

  sidebar.window.MBBS_DISPATCH_OPERATOR = {
    role: "operator",
    roles: ["operator", "sales", "mbt-frontdesk"]
  };
  assert.deepEqual(hrefs(), ["/sales", "/mbt", "/operator"]);

  sidebar.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["admin"]));
  sidebar.window.MBBS_DISPATCH_OPERATOR = { role: "sales", roles: ["sales"], publicSales: true };
  assert.deepEqual(hrefs(), ["/sales"], "Public Sales must never inherit stored staff navigation.");

  sidebar.window.MBBS_DISPATCH_OPERATOR = null;
  sidebar.localStorage.clear();
  sidebar.localStorage.setItem("mbbs.staff.roles", JSON.stringify(["dispatcher"]));
  assert.deepEqual(hrefs(), ["/dispatch", "/scm", "/mbt"]);

  sidebar.localStorage.clear();
  sidebar.setSidebarOperator({ role: "admin", roles: ["admin"] });
  assert.deepEqual(hrefs(), ["/admin", "/control", "/dispatch", "/scm", "/sales", "/mbt", "/operator"]);

  assert.doesNotMatch(sidebarSource, /if \(path\.startsWith\("\/mbt"\)\) return visibleMbtItems\(\)/);
  assert.doesNotMatch(sidebarSource, /if \(path\.startsWith\("\/sales"\)\) return mainItems/);
  assert.match(sidebarSource, /<nav class="app-sidebar-section" aria-label="Main modules">/);
  assert.match(sidebarSource, /fetch\("\/api\/auth\/me"/);
});

test("SCM menu decisions include normalized secondary authorities", () => {
  const helpers = between(scmMenu, "function scmMenuRoles()", "function renderScmMenu()");
  const harness = Function(`
    let scmMenuOperator = null;
    ${helpers}
    return {
      setOperator(value) { scmMenuOperator = value; },
      scmCanEditScm,
      scmIsYardManager
    };
  `)();

  harness.setOperator({ role: "dispatcher", roles: ["dispatcher", "SCM Staff"] });
  assert.equal(harness.scmCanEditScm(), true);
  assert.equal(harness.scmIsYardManager(), false);

  harness.setOperator({ role: "yard-manager", roles: ["yard-manager"] });
  assert.equal(harness.scmCanEditScm(), false);
  assert.equal(harness.scmIsYardManager(), true);
});
