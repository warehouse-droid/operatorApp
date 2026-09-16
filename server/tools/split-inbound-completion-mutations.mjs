import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {runNode,focused} from "./split-inbound-completion-suite.mjs";

const artifact=path.resolve("test-artifacts/split-inbound-completion");
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"split-inbound-mutants-"));
const helper="src/smart-scm-split-inbound-sql.js";
const mutations=[
  ["ignore-completion",helper,"completion.dispatch_completion_status = 'completed'","completion.dispatch_completion_status = 'pending'"],
  ["ignore-receipt-header",helper,"= 'received'","= 'never_received'"],
  ["allow-wrong-order-kind",helper,"completion.order_kind = 'PO'","true"],
  ["case-sensitive-reference",helper,"lower(btrim(completion.order_ref)) = lower(btrim(split.split_po_ref))","completion.order_ref = split.split_po_ref"],
  ["ignore-latest-receipt",helper,"COALESCE(${line}.netsuite_received_qty, 0)","0"],
  ["ignore-local-receipt",helper,"+ CASE WHEN ${line}.confirmed_at IS NOT NULL","+ CASE WHEN false"],
  ["double-count-receipts",helper,"COALESCE(${line}.quantity, 0) - GREATEST(","COALESCE(${line}.quantity, 0) - COALESCE(${line}.netsuite_received_qty, 0) - GREATEST("],
  ["accept-unconfirmed-draft",helper,"${line}.confirmed_at IS NOT NULL\n                 AND ${line}.confirmed_at <= ${po}.received_at","true"],
  ["accept-unposted-draft",helper,"AND ${line}.confirmed_at <= ${po}.received_at\n                 AND lower(btrim(COALESCE(${po}.receipt_status, ''))) = 'partial_received'","AND true"],
  ["reuse-old-partial-receipt",helper,"AND ${line}.confirmed_at <= ${po}.received_at","AND true"],
  ["include-closed-child","src/smart-scm-proposal-editor.js","AND NOT COALESCE(child_line.netsuite_closed, false)","AND true"],
  ["drop-same-yard-blanket","src/smart-scm-proposal-editor.js","AND source_po.is_blanket_po = true","AND source_po.is_blanket_po = true AND child_po.destination_location_id <> source_po.destination_location_id"]
];
const results=[];
try {
  for(const folder of ["src","test","public"])fs.cpSync(folder,path.join(scratch,folder),{recursive:true});
  fs.copyFileSync("package.json",path.join(scratch,"package.json"));
  fs.symlinkSync(path.resolve("node_modules"),path.join(scratch,"node_modules"));
  for(const [name,file,from,to] of mutations) {
    const original=fs.readFileSync(file,"utf8");
    assert.equal(original.split(from).length,2,`${name}: unique mutation site`);
    const destination=path.join(scratch,file);
    fs.writeFileSync(destination,original.replace(from,to));
    const suite=runNode(["--test",...focused],{cwd:scratch,log:`${artifact}/mutant-${name}.log`});
    const property=runNode(["--test","--test-name-pattern=property:",...focused],{cwd:scratch,log:`${artifact}/mutant-${name}-property.log`});
    const assertionFailure=result=>result.status!==0&&/^not ok/m.test(result.output)&&/ERR_ASSERTION|Property failed/.test(result.output);
    results.push({name,killed:assertionFailure(suite),propertyKilled:assertionFailure(property)});
    fs.writeFileSync(destination,original);
    console.log(JSON.stringify(results.at(-1)));
  }
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
fs.writeFileSync(`${artifact}/mutations.json`,JSON.stringify(results,null,2));
assert.ok(results.every(r=>r.killed),"Every selected fault must be detected by an assertion.");
