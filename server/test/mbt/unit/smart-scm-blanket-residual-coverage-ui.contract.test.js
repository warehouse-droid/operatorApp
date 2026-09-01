import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const exclusions = fs.readFileSync(new URL("../../../public/scm-smart-exclusions.js", import.meta.url), "utf8");
const proposals = fs.readFileSync(new URL("../../../public/scm-smart-proposals.js", import.meta.url), "utf8");
const blankets = fs.readFileSync(new URL("../../../public/scm-smart-blanket.js", import.meta.url), "utf8");
const planningRepository = fs.readFileSync(new URL("../../../src/smart-scm-planning-repository.js", import.meta.url), "utf8");
const blanketRepository = fs.readFileSync(new URL("../../../src/smart-scm-blanket-repository.js", import.meta.url), "utf8");

test("Blanket items are presented as quantity coverage rather than an entire-item PO pause", () => {
  assert.match(proposals, /Coverage & pauses/);
  assert.match(exclusions, /Automatic — Blanket coverage/);
  assert.match(exclusions, /Uncovered demand remains eligible for PO\/TO planning/);
  assert.doesNotMatch(exclusions, /Vendor PO planning paused/);
  assert.match(blankets, /uncovered demand remains in regular PO\/TO planning/);
  assert.match(planningRepository, /planningEffect:\s*"quantity_offset"/);
});

test("proposal decision evidence exposes Blanket coverage and ordinary residual quantities", () => {
  assert.match(proposals, /reason\.blanketCoveragePallets/);
  assert.match(proposals, /reason\.residualRequiredPallets/);
  assert.match(proposals, /Blanket coverage/);
  assert.match(proposals, /PO\/TO residual/);
});

test("both inventory and Blanket planning runs persist the shared coverage snapshot", () => {
  assert.match(planningRepository, /smartScmBlanketCoverageSnapshot\(states\)/);
  assert.match(blanketRepository, /smartScmBlanketCoverageSnapshot\(planning\.states\)/);
  assert.match(blanketRepository, /\.\.\.coverageSnapshot/);
});
