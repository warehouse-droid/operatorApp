import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, css, html, repository, preferenceRepository, specialOrderMigration] = await Promise.all([
  readFile(new URL("../public/scm-schedule.js", import.meta.url), "utf8"),
  readFile(new URL("../public/dispatch.css", import.meta.url), "utf8"),
  readFile(new URL("../public/scm-schedule.html", import.meta.url), "utf8"),
  readFile(new URL("./dispatch-repository.js", import.meta.url), "utf8"),
  readFile(new URL("./scm-schedule-preference-repository.js", import.meta.url), "utf8"),
  readFile(new URL("../migrations/084_scm_schedule_special_order_preference.sql", import.meta.url), "utf8")
]);

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert(start >= 0, `Missing ${name}.`);
  assert(end > start, `Could not isolate ${name}.`);
  return source.slice(start, end);
}

function includesAll(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing: ${value}`);
  }
}

const columnFilterRenderer = functionSource(
  client,
  "scmScheduleColumnFilterHtml",
  "scmScheduleHeaderHtml"
);
includesAll(columnFilterRenderer, [
  'column.key === "type"',
  'field: "kind"',
  'column.key === "method"',
  'field: "method"',
  'column.key === "dropoff"',
  'field: "dropoffPoint"',
  'column.key === "brand"',
  'field: "brand"',
  'column.key === "status"',
  'field: "status"',
  'column.key === "eta"',
  "scmScheduleDateFilterHtml"
], "Spreadsheet column-filter mapping");
assert(
  columnFilterRenderer.includes("Sp.O")
    || (
      columnFilterRenderer.includes("SCM_TYPE_FILTERS")
      && /SCM_TYPE_FILTERS\s*=\s*(?:Object\.freeze\()?[\s\S]{0,160}[\"']Sp\.O[\"']/.test(client)
    )
    || (
      columnFilterRenderer.includes("SCM_TYPES")
      && /SCM_TYPES\s*=\s*(?:Object\.freeze\()?[\s\S]{0,160}[\"']Sp\.O[\"']/.test(client)
    ),
  "The Type column filter does not offer Sp.O."
);
includesAll(client, [
  'rawKind === "SP.O" ? "Sp.O" : rawKind',
  'scmScheduleFilters.kind === "Sp.O"',
  'row.orderKind === "PO" && row.isSpecialOrder'
], "Special Order client filtering");
includesAll(repository, [
  'cleanKind = rawKind === "SP.O" ? "Sp.O" : rawKind',
  "$4 = 'Sp.O' AND b.order_kind = 'PO' AND COALESCE(s.is_special_order, false)",
  "$4 <> 'Sp.O' AND b.order_kind = $4"
], "Special Order schedule query");
includesAll(preferenceRepository, [
  '"Sp.O"',
  'raw === "SP.O" ? "Sp.O" : raw',
  "allowlistedKind"
], "Special Order preference normalization");
assert(specialOrderMigration.includes("'Sp.O'"),
  "The persisted Type preference constraint does not permit Sp.O.");

const headerRenderer = functionSource(client, "scmScheduleHeaderHtml", "applyScmScheduleSheetPreferences");
includesAll(headerRenderer, [
  "scmScheduleColumnFilterHtml",
  "scm-sheet-header",
  "scm-sheet-header-label",
  "${filter}",
  "scm-column-resizer"
], "Schedule column header renderer");

const renderStart = client.indexOf("function renderScmSchedule");
const toolbarStart = client.indexOf('<div class="scm-schedule-toolbar">', renderStart);
const toolbarEnd = client.indexOf('<div class="scm-sheet-wrap">', toolbarStart);
assert(renderStart >= 0 && toolbarStart > renderStart && toolbarEnd > toolbarStart,
  "Could not isolate the PO/TO Schedule toolbar.");
const toolbar = client.slice(toolbarStart, toolbarEnd);
assert(toolbar.includes('data-filter="search"'),
  "Global search must remain in the schedule toolbar.");
for (const oldToolbarControl of [
  'data-filter="kind"',
  'data-filter="method"',
  'data-filter="dropoffPoint"',
  'data-filter="from"',
  'data-filter="to"',
  'field: "status"',
  'field: "brand"'
]) {
  assert(!toolbar.includes(oldToolbarControl),
    `Structured filter still renders directly in the toolbar: ${oldToolbarControl}`);
}
assert(client.slice(renderStart).includes("scmScheduleHeaderHtml(column, {"),
  "Schedule headers are not receiving the filter-rendering context.");

const multiFilterUpdate = functionSource(
  client,
  "updateScmScheduleMultiFilter",
  "queueScmScheduleSearch"
);
includesAll(multiFilterUpdate, [
  "{ commit = true }",
  "if (commit) scmScheduleFilters[field] = values"
], "Multi-select draft behavior");
assert.match(
  client,
  /data-multi-filter-option[\s\S]{0,260}updateScmScheduleMultiFilter\([\s\S]{0,160}\{\s*commit:\s*false\s*\}/,
  "Changing a Status or Brand checkbox must update only the draft until Apply."
);
assert.match(
  client,
  /data-deferred-column-filter[\s\S]{0,260}updateScmScheduleDateFilterSummary[\s\S]{0,80}return;/,
  "Changing an ETA date must update only the draft summary until Apply."
);
includesAll(client, [
  'data-action="apply-column-filters"',
  'action === "apply-column-filters"',
  "await applyScmScheduleFilters()"
], "Column-filter Apply behavior");
const applyFilters = functionSource(client, "applyScmScheduleFilters", "selectHtml");
includesAll(applyFilters, [
  'querySelectorAll("[data-filter]")',
  'querySelectorAll("[data-multi-filter]")',
  "{ commit: true }",
  "saveScmScheduleFilterPreference()",
  "await loadScmSchedule()"
], "Committed column-filter behavior");

includesAll(client, [
  'data-action="clear-column-filters"',
  'action === "clear-column-filters"',
  'scmScheduleFilters.kind = ""',
  'scmScheduleFilters.method = ""',
  "scmScheduleFilters.status = []",
  'scmScheduleFilters.dropoffPoint = ""',
  "scmScheduleFilters.brand = []",
  'scmScheduleFilters.from = ""',
  'scmScheduleFilters.to = ""'
], "Clear-column-filters behavior");

includesAll(css, [
  ".scm-sheet-header.has-column-filter",
  ".scm-column-filter-select",
  ".scm-sheet-header .scm-multi-filter",
  ".scm-column-date-filter",
  ".scm-column-filter-menu"
], "Spreadsheet column-filter styling");

assert(client.includes("<span>Sp.O</span>"),
  "The Special Order checkbox label must expose a distinct Sp.O text element.");
includesAll(client, [
  "function scmScheduleDisplayType",
  'row.isSpecialOrder && !scmWorkingView ? "Sp.O" : row.orderKind',
  "const scmWorkingView = editable",
  'scmWorkingView && row.orderKind === "PO"'
], "Special Order display by schedule view");
const cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selectors: match[1], declarations: match[2] }))
  .filter((rule) =>
    rule.selectors.includes(".scm-sheet-check")
    && /color\s*:\s*inherit\s*;?/.test(rule.declarations)
  );
assert(
  cssRules.some((rule) => rule.selectors.includes(".scm-sheet-row.scm-custom-row-format")),
  "Sp.O does not inherit a custom whole-row font color."
);
assert(
  cssRules.some((rule) => rule.selectors.includes(".scm-sheet-cell.scm-custom-cell-format")),
  "Sp.O does not inherit its custom Type-cell font color."
);

assert.match(
  html,
  /\/scm-schedule\.js\?v=[^"'<>]+/,
  "The schedule page must use a cache-busted client asset."
);

console.log("PO/TO Schedule spreadsheet column-filter and Sp.O font harness passed.");
