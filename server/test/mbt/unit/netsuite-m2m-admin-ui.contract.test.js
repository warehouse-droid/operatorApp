import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (relativePath) => readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8");

test("M2M-UI-1: Admin exposes staged certificate generation, public download, activation probe, fallback, and Pending-Approval-only sync", async () => {
  const [control, server] = await Promise.all([
    source("public/control.js"),
    source("src/server.js")
  ]);
  assert.match(control, /NetSuite Machine-to-Machine Authentication/u);
  assert.match(control, /Generate staged certificate/u);
  assert.match(control, /Download public certificate/u);
  assert.match(control, /encrypted private-key recovery backup/u);
  assert.match(control, /Test and activate M2M/u);
  assert.match(control, /Use browser OAuth fallback/u);
  assert.match(control, /Reconcile Pending Approval now/u);
  assert.match(server, /app\.get\("\/api\/admin\/netsuite-m2m"/u);
  assert.match(server, /app\.post\("\/api\/admin\/netsuite-m2m\/certificates"/u);
  assert.match(server, /app\.get\("\/api\/admin\/netsuite-m2m\/certificates\/:slot\/public"/u);
  assert.match(server, /app\.post\("\/api\/admin\/netsuite-m2m\/activate"/u);
  assert.match(server, /app\.post\("\/api\/admin\/netsuite-m2m\/fallback"/u);
  assert.match(server, /app\.post\("\/api\/admin\/pending-approval-reconcile"/u);
});

test("M2M-UI-2: no endpoint permits raw or repeat private-key download and audit sanitization covers passphrases", async () => {
  const [control, server] = await Promise.all([
    source("public/control.js"),
    source("src/server.js")
  ]);
  assert.doesNotMatch(server, /app\.get\([^\n]*private[-_/]?key/iu);
  assert.doesNotMatch(control, /Download raw private key/iu);
  assert.match(server, /passphrase\|private[^/]*\|credential/iu);
});

test("M2M-UI-3: token renewal does not schedule whole-order or Pending Approval polling", async () => {
  const [control, server, runtime] = await Promise.all([
    source("public/control.js"),
    source("src/server.js"),
    source("src/netsuite-m2m-runtime.js")
  ]);
  assert.match(control, /existing webhook remains the automatic order-status trigger/iu);
  assert.equal((server.match(/runPendingApprovalReconciliation\(/gu) || []).length, 2);
  assert.doesNotMatch(server, /set(?:Interval|Timeout)\([^;]*runPendingApprovalReconciliation/su);
  assert.doesNotMatch(runtime, /setInterval|setTimeout|nightly/iu);
});
