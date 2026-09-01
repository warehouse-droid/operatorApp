import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../../../public/dispatch.html", import.meta.url), "utf8");

function poRefSearchContext() {
  const start = client.indexOf("function poLinkEntryRefs");
  const end = client.indexOf("function poLinkCandidateLinesForSalesLine", start);
  assert.ok(start >= 0 && end > start, "Link PO ref helpers must remain directly testable");
  const context = vm.createContext({ poAllocationOptions: null });
  vm.runInContext(client.slice(start, end), context);
  return context;
}

test("Link PO matches the current PO ref and retained source PO number", () => {
  const context = poRefSearchContext();
  context.poAllocationOptions = {
    poLines: [{
      id: 41,
      poRef: "SN1391496-REF",
      originalPoRef: "POB03321",
      poAliases: ["SN1391496-REF", "POB03321"]
    }]
  };
  const current = vm.runInContext('poLinkLinesForRef("sn1391496-ref")', context);
  const original = vm.runInContext('poLinkLinesForRef("pob03321")', context);
  assert.deepEqual(Array.from(current, (line) => Number(line.id)), [41]);
  assert.deepEqual(Array.from(original, (line) => Number(line.id)), [41]);

  const candidateLine = {
    poCandidates: [{
      poLineId: 41,
      poRef: "SN1391496-REF",
      originalPoRef: "POB03321",
      poAliases: ["SN1391496-REF", "POB03321"]
    }]
  };
  context.candidateLine = candidateLine;
  assert.equal(vm.runInContext('poLinkCandidateMetaForLine(candidateLine, "SN1391496-REF").length', context), 1);
  assert.equal(vm.runInContext('poLinkCandidateMetaForLine(candidateLine, "POB03321").length', context), 1);
});

test("Dispatch loads the PO-ref search client generation", () => {
  assert.match(page, /dispatch\.js\?v=20260831-po-link-inline-service-v3/u);
});
