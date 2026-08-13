// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ path?: string, statementMap: Record<string, { start: { line: number }, end: { line: number } }>, s: Record<string, number> }} FileCoverage */

const reportDirectory = path.resolve(process.argv[2] || "test-artifacts/delivery-instruction-coverage");
const [coverageText, summaryText] = await Promise.all([
  readFile(path.join(reportDirectory, "coverage-final.json"), "utf8"),
  readFile(path.join(reportDirectory, "coverage-summary.json"), "utf8")
]);
/** @type {Record<string, FileCoverage>} */
const coverageDocument = JSON.parse(coverageText);
const summary = JSON.parse(summaryText);

assert(summary.total.lines.pct >= 98, `Delivery-instruction line coverage ${summary.total.lines.pct}% is below 98%.`);
assert(summary.total.statements.pct >= 98, `Delivery-instruction statement coverage ${summary.total.statements.pct}% is below 98%.`);
assert.equal(summary.total.functions.pct, 100, "Delivery-instruction function coverage must remain 100%.");
assert(summary.total.branches.pct >= 65, `Delivery-instruction branch coverage ${summary.total.branches.pct}% is below 65%.`);

/** @type {Array<{ path: string, probes: Array<[string, string]> }>} */
const targets = [
  {
    path: path.resolve("src/delivery-instruction-domain.js"),
    probes: [
      ["planned address/date classification", "const plannedMatch = line.match(ADDRESS_LABEL)"],
      ["ambiguous raw memo fallback", "const text = ambiguous ? rawMemo"],
      ["telephone link extraction", "phones.push({ display, href })"],
      ["five-file boundary", "Number(activeCount) >= DELIVERY_INSTRUCTION_MAX_MEDIA"],
      ["25 MiB boundary", "byteSize > DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES"],
      ["revision conflict", "expected !== actual"],
      ["Driver completion lock", "if (dropoffCompleted)"],
      ["upload object identity", "String(parts[5] || \"\").toLowerCase() === id"]
    ]
  },
  {
    path: path.resolve("src/delivery-instruction-repository.js"),
    probes: [
      ["Sales yard isolation", "!authorized.includes(Number(row.ordering_location_id))"],
      ["structured parser projection", "text: details.text"],
      ["stale text guard", "assertDeliveryInstructionRevision(input.expectedRevision, row.revision)"],
      ["pending upload slot reservation", "FROM sales_order_delivery_instruction_upload_tickets"],
      ["replacement tickets do not consume a second slot", "AND replacement_media_id IS NULL"],
      ["ticket actor binding", "String(ticket.issued_by || \"\") !== String(context.operatorId || \"\")"],
      ["additive post-upload registration", "const ticketResult = await query("],
      ["upload metadata binding", "DELIVERY_INSTRUCTION_UPLOAD_MISMATCH"],
      ["upload object-reference binding", "DELIVERY_INSTRUCTION_UPLOAD_REFERENCE"],
      ["replacement keeps gallery position", "replacement ? Number(replacement.position)"],
      ["soft deletion", "SET deleted_at = now()"],
      ["Driver batch read", "if (!ids.length) return {};"]
    ]
  }
];

/** @param {FileCoverage} fileCoverage @param {number} line */
function statementHitForLine(fileCoverage, line) {
  const candidates = Object.entries(fileCoverage.statementMap)
    .filter(([, location]) => location.start.line <= line && location.end.line >= line)
    .sort((left, right) => {
      const leftSpan = left[1].end.line - left[1].start.line;
      const rightSpan = right[1].end.line - right[1].start.line;
      return leftSpan - rightSpan;
    });
  assert(candidates.length, `No instrumented statement contains changed line ${line}.`);
  const [candidate] = candidates;
  assert(candidate);
  return Number(fileCoverage.s[candidate[0]] || 0);
}

let executed = 0;
let total = 0;
for (const target of targets) {
  const source = await readFile(target.path, "utf8");
  const fileCoverage = Object.values(coverageDocument).find((entry) =>
    path.resolve(String(entry?.path || "")) === target.path
  );
  assert(fileCoverage, `${path.basename(target.path)} coverage was not recorded.`);
  for (const [label, needle] of target.probes) {
    total += 1;
    const offset = source.indexOf(needle);
    assert.notEqual(offset, -1, `${label}: coverage probe source was not found.`);
    const line = source.slice(0, offset).split("\n").length;
    assert(statementHitForLine(fileCoverage, line) > 0, `${label} was not executed (line ${line}).`);
    executed += 1;
  }
}

console.log(
  `Delivery-instruction critical changed-line probes: ${executed}/${total}; `
  + `lines ${summary.total.lines.pct}%, branches ${summary.total.branches.pct}%, functions 100%.`
);
