// @ts-check

import { readFile } from "node:fs/promises";

/** @typedef {{name?: string}} FunctionLocation */
/** @typedef {{fnMap: Record<string, FunctionLocation>, f: Record<string, number>}} FileCoverage */

const reportPath = process.argv[2]
  || "test-artifacts/global-order-pool-dependency-preview-coverage/coverage-final.json";
/** @type {Record<string, FileCoverage>} */
const report = JSON.parse(await readFile(reportPath, "utf8"));

const required = Object.freeze({
  "src/dispatch-delivery-group-repository.js": Object.freeze([
    "globalGroupSnapshot",
    "projectGlobalGroups",
    "syncDispatchGlobalOrderGroupsFromPlan",
    "syncDispatchDeliveryGroupsFromPlan"
  ]),
  "src/dispatch-order-catalog-repository.js": Object.freeze([
    "getDispatchOrderCatalogOrder",
    "listDispatchOrderPool"
  ]),
  "src/scm-dependency-preview-service.js": Object.freeze([
    "dependencyExecutionIds",
    "driverActivity",
    "previewScmDependencyMutation"
  ])
});

/** @param {string} file @returns {FileCoverage} */
function coverageFor(file) {
  const entries = Object.entries(report).filter(([key]) => key.endsWith(`/${file}`));
  if (entries.length !== 1) {
    throw new Error(`${file}: expected one coverage document, found ${entries.length}.`);
  }
  const entry = entries[0];
  if (!entry) {throw new Error(`${file}: coverage document disappeared after validation.`);}
  return entry[1];
}

let covered = 0;
for (const [file, names] of Object.entries(required)) {
  const coverage = coverageFor(file);
  for (const name of names) {
    const ids = Object.entries(coverage.fnMap)
      .filter(([, location]) => location.name === name)
      .map(([id]) => id);
    if (ids.length !== 1) {throw new Error(`${file}: expected one function named ${name}.`);}
    const id = ids[0];
    if (id === undefined || Number(coverage.f[id] || 0) === 0) {
      throw new Error(`${file}: ${name} was not executed.`);
    }
    covered += 1;
  }
}

console.log(
  `Focused changed-function coverage: ${covered}/${covered}; SQL decision boundaries are additionally mutation-tested.`
);
