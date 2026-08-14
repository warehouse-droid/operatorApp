// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(process.argv[2] || "/tmp/scm-po-split-ui-coverage/coverage-final.json");
const coverage = JSON.parse(await readFile(reportPath, "utf8"));
const [clientPath, clientCoverage] = Object.entries(coverage).find(([file]) =>
  file.endsWith("/public/dispatch-scm.js")
) || [];
assert.ok(clientCoverage, "dispatch-scm.js is missing from the c8 report.");

const source = await readFile(path.resolve("public/dispatch-scm.js"), "utf8");
const sourceLines = source.split("\n");
/** @param {string} marker */
const lineFor = (marker) => {
  const line = sourceLines.findIndex((value) => value.includes(marker)) + 1;
  assert.ok(line > 0, `Coverage marker not found: ${marker}`);
  return line;
};

const requiredFunctions = [
  "scmLiveSplitDestinationLocationId",
  "scmLiveSplitPickupPoint",
  "renderScmScheduleMiniPanel",
  "createScmSplit"
];
const functionsByName = new Map(Object.entries(clientCoverage.fnMap).map(([id, entry]) => [
  entry.name,
  { id, entry, count: Number(clientCoverage.f[id] || 0) }
]));
for (const name of requiredFunctions) {
  const covered = functionsByName.get(name);
  assert.ok(covered, `Coverage function not found: ${name}`);
  assert.ok(covered.count > 0, `${name} was not executed.`);
}

const destinationCoverage = functionsByName.get("scmLiveSplitDestinationLocationId");
const pickupCoverage = functionsByName.get("scmLiveSplitPickupPoint");
assert.ok(destinationCoverage, "Destination-yard coverage metadata is missing.");
assert.ok(pickupCoverage, "Pickup-yard coverage metadata is missing.");
const coveredRanges = [
  destinationCoverage.entry.loc,
  pickupCoverage.entry.loc
];
const requiredLines = new Set([
  lineFor('data-action="unsplit-order"'),
  lineFor("const destinationLocationId = scmLiveSplitDestinationLocationId(order);"),
  lineFor("const pickupPoint = scmVendorYardOptions(order).length ? scmLiveSplitPickupPoint(order) : \"\";")
]);
/** @param {number} line */
const inChangedScope = (line) => requiredLines.has(line) || coveredRanges.some((range) =>
  line >= range.start.line && line <= range.end.line
);

const changedStatements = Object.entries(clientCoverage.statementMap).filter(([, entry]) =>
  inChangedScope(entry.start.line)
);
assert.ok(changedStatements.length > 0, "No changed PO-split statements were found in the c8 report.");
for (const [id, entry] of changedStatements) {
  assert.ok(Number(clientCoverage.s[id] || 0) > 0, `Changed statement at line ${entry.start.line} was not executed.`);
}

const changedBranches = Object.entries(clientCoverage.branchMap).filter(([, entry]) =>
  inChangedScope(entry.loc.start.line)
);
assert.ok(changedBranches.length > 0, "No changed PO-split branches were found in the c8 report.");
for (const [id, entry] of changedBranches) {
  for (const count of clientCoverage.b[id] || []) {
    assert.ok(Number(count) > 0, `Changed branch at line ${entry.loc.start.line} was not exercised both ways.`);
  }
}

console.log(JSON.stringify({
  ok: true,
  file: clientPath,
  changedStatements: changedStatements.length,
  changedBranches: changedBranches.length,
  requiredFunctions: requiredFunctions.length
}));
