import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, script, css] = await Promise.all([
  readFile(new URL("../../../public/mbt-billing.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-billing.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.css", import.meta.url), "utf8")
]);

test("P3-F23–P3-F28 billing page exposes local-only case, evidence, allocation, and variance controls", () => {
  assert.match(html, /Local only/i);
  assert.match(html, /No outbox or NetSuite transport/i);
  assert.match(html, /Billing case queue/i);
  assert.match(html, /Calculation evidence and versions/i);
  assert.match(html, /Completed MBBS order candidates/i);
  assert.match(html, /Driver PWA and reconciliation/i);
  assert.match(html, /DELIVERY_CHARGE_MBBS/u);
  assert.match(html, /MBBS cross-charge generation/i);
  assert.match(html, /completed-load snapshot IDs/i);
  assert.match(html, /caller-authored loads are rejected/i);
  assert.match(html, /Pilot reconciliation/i);
  assert.match(html, /mbt-billing\.js/iu);
  assert.match(css, /data-mbt-surface=["']billing["']/u);
});

test("P3-F27 browser contract keeps reads available while disabling every command from server gate state", () => {
  assert.match(script, /\/api\/mbt\/billing\/status/u);
  assert.match(script, /commandsEnabled\s*=\s*result\.commandState\?\.enabled\s*===\s*true/u);
  assert.match(script, /querySelectorAll\(["']\.mbt-command["']\)/u);
  assert.match(script, /button\.disabled\s*=\s*!state\.commandsEnabled/u);
  assert.match(script, /\/api\/mbt\/billing\/cases/u);
  assert.match(script, /\/api\/mbt\/billing\/mbbs\/candidates/u);
  assert.match(script, /\/candidates\/\$\{encodeURIComponent\(candidateId\)\}\/preview/u);
  assert.match(script, /local_only_preview/u);
  assert.match(script, /\/api\/mbt\/reconciliation\/batches/u);
});

test("P3-F25/P3-F26/P3-F28 browser contract delegates money and reconciliation truth to server endpoints", () => {
  assert.match(script, /\/calculate/u);
  assert.match(script, /\/approve-local/u);
  assert.match(script, /\/billing\/mbbs\/generate/u);
  assert.match(script, /MBBS snapshot generation evidence/u);
  assert.match(script, /\/resolve/u);
  assert.doesNotMatch(script, /subtotalMinor\s*=|totalMinor\s*=|allocatedAmountMinor\s*=/u);
  assert.doesNotMatch(script, /netsuite.*(?:post|write)|(?:post|write).*netsuite/iu);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML/u);
});

test("P3-F25 browser contract prefills the server-bound visit and immutable visit-distance identity", () => {
  assert.match(script, /calculationVisitId["'],\s*result\.serviceVisitId/u);
  assert.match(script, /calculationDistanceId["'],\s*result\.visitDistanceSnapshotId/u);
  assert.match(script, /visit\/distance binding incomplete/u);
});
