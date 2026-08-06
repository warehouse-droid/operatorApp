import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../../src/mbt/bin-dispatch-service.js", import.meta.url),
  "utf8"
);

test("multi-bin Dispatch evaluates the current leg independently for each physical service line", () => {
  assert.match(source, /service_line_id::text/u);
  assert.match(source, /function\s+selectContractVisits|async\s+function\s+selectContractVisits/u);
  assert.match(
    source,
    /selectContractVisits\(String\(candidate\.contract_id\),\s*\{[\s\S]{0,200}serviceLineId:\s*candidate\.service_line_id/u,
    "The pool projection must not mix sibling physical-bin chains."
  );
  const currentStart = source.indexOf("async function assertCurrentFrontLeg");
  const currentEnd = source.indexOf("async function assertLockedTemplateAndStops", currentStart);
  assert.ok(currentStart >= 0 && currentEnd > currentStart);
  assert.match(
    source.slice(currentStart, currentEnd),
    /serviceLineId:\s*visit\.service_line_id/u,
    "Confirmation must check active peers only within the same physical-bin line."
  );
});

test("multi-bin cards and durable assignment snapshots retain service-line identity", () => {
  const projectionStart = source.indexOf("async function projectFrontLeg");
  const projectionEnd = source.indexOf("export async function listMbtBinFrontLegs", projectionStart);
  assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
  assert.match(source.slice(projectionStart, projectionEnd), /serviceLineId:\s*visit\.service_line_id/u);

  const assignmentStart = source.indexOf("export async function assignMbtBinFrontLeg");
  const assignmentEnd = source.indexOf("export async function moveMbtBinFrontLegAssignment", assignmentStart);
  assert.ok(assignmentStart >= 0 && assignmentEnd > assignmentStart);
  assert.match(source.slice(assignmentStart, assignmentEnd), /serviceLineId:\s*visit\.service_line_id/u);
});

test("contract timeline derives current/future relation per service line rather than across sibling bins", () => {
  assert.match(source, /function\s+contractTimelineFor\s*\(/u);
  const timelineStart = source.indexOf("function contractTimelineFor");
  const timelineEnd = source.indexOf("async function selectContractVisits", timelineStart);
  assert.ok(timelineStart >= 0 && timelineEnd > timelineStart);
  const timeline = source.slice(timelineStart, timelineEnd);
  assert.match(timeline, /service_line_id/u);
  assert.match(timeline, /timelineFor\(/u);
});
