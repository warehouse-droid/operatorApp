// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(process.argv[2]
  || "test-artifacts/scm-netsuite-address-pickup-coverage/coverage-final.json");
const sourceFile = "src/dispatch-repository.js";
/** @type {Record<string, {
 * path?: string,
 * statementMap: Record<string, { start: { line: number }, end: { line: number } }>,
 * s: Record<string, number>
 * }>} */
const report = JSON.parse(await readFile(reportPath, "utf8"));
const coverage = Object.values(report).find((entry) =>
  path.resolve(String(entry?.path || "")) === path.resolve(sourceFile)
);
assert.ok(coverage, `${sourceFile} is missing from the c8 report.`);

const source = await readFile(path.resolve(sourceFile), "utf8");
const probes = [
  "const unchanged = isUnchangedScmPoPickup({ requestedPickup, currentPickup, groupRef });",
  "return isUnchangedScmPoPickup({",
  "if (!unchanged) {",
  "next.pickupPoint = String(current.pickup_point || \"\").trim();",
  "next.pickupPoint = selected;"
];

for (const probe of probes) {
  const offset = source.indexOf(probe);
  assert.notEqual(offset, -1, `Coverage probe is missing from source: ${probe}`);
  const line = source.slice(0, offset).split("\n").length;
  const statementIds = Object.entries(coverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .map(([id]) => id);
  assert.ok(statementIds.length, `No instrumented statement contains ${sourceFile}:${line}.`);
  assert.ok(statementIds.some((id) => Number(coverage.s[id] || 0) > 0),
    `Changed statement was not executed at ${sourceFile}:${line}.`);
}

console.log(JSON.stringify({ ok: true, probes: probes.length, file: sourceFile }));
