import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = fs.readFileSync(new URL("../../../public/scm-dependency-management.js", import.meta.url), "utf8");

function poRefSearchContext() {
  const start = client.indexOf("function dependencyPoEntryRefs");
  const end = client.indexOf("function renderPoLinkLines", start);
  assert.ok(start >= 0 && end > start, "SCM PO ref helpers must remain directly testable");
  const context = vm.createContext({});
  vm.runInContext(client.slice(start, end), context);
  return context;
}

test("SCM Link PO matches an updated PO ref and its original NetSuite number", () => {
  const context = poRefSearchContext();
  context.poLine = {
    poRef: "SN1391496-REF",
    originalPoRef: "POB03321",
    poAliases: ["SN1391496-REF", "POB03321"]
  };

  assert.equal(vm.runInContext('dependencyPoRefMatches(poLine, "sn1391496-ref")', context), true);
  assert.equal(vm.runInContext('dependencyPoRefMatches(poLine, "pob03321")', context), true);
  assert.equal(vm.runInContext('dependencyPoRefMatches(poLine, "POB99999")', context), false);
});
