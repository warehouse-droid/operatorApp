import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const directory="test-artifacts/smart-scm-created-po-sync";
mkdirSync(directory,{recursive:true});
const results=[];
function run(name,command,args,{accept=null}={}) {
  const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:40*1024*1024});
  if(result.error) throw result.error;
  const output=`${result.stdout}${result.stderr}`;
  writeFileSync(`${directory}/${name}.log`,output);
  const accepted=accept ? accept(result,output) : result.status===0;
  results.push({name,exitCode:result.status,accepted});
  writeFileSync(`${directory}/gauntlet.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(accepted,`${name} failed; see ${directory}/${name}.log`);
  return output;
}

const tests=[
  "test/mbt/unit/smart-scm-created-po.test.js",
  "test/mbt/unit/smart-scm-created-po-service.test.js",
  "test/mbt/unit/smart-scm-created-po-ui.test.js",
  "test/mbt/unit/scm-netsuite-po-version.test.js",
  "test/mbt/unit/smart-scm-vendor-po-financials.test.js",
  "test/mbt/unit/smart-scm-vendor-financials.test.js",
  "test/mbt/unit/netsuite-order-webhook-financials.test.js",
  "test/mbt/unit/smart-scm-vendor-po-live-sync.test.js",
  "test/mbt/integration/smart-scm-vendor-unit-price.test.js",
  "src/scm-netsuite-po-history-harness.js",
  "src/scm-netsuite-po-unit-conversion-harness.js",
  "src/smart-scm-vendor-ui-harness.js",
  "src/smart-scm-vendor-workflow-harness.js",
  "src/smart-scm-purchase-review-harness.js"
];
const files=[
  "src/smart-scm-created-po.js","src/scm-netsuite-po-version.js",
  "src/smart-scm-vendor-workflow-repository.js","src/scm-netsuite-po-history-repository.js",
  "src/scm-netsuite-po-history-service.js","src/netsuite.js"
];
run("focused",process.execPath,["--test","--test-concurrency=1",...tests]);
run("coverage","node_modules/.bin/c8",[
  "--all=false","--check-coverage=false",...files.map(file=>`--include=${file}`),
  `--temp-directory=${directory}/c8`,`--report-dir=${directory}/coverage`,
  "--reporter=json","--reporter=json-summary","--reporter=text",
  process.execPath,"--test","--test-concurrency=1",...tests
]);
run("changed-coverage",process.execPath,["tools/smart-scm-created-po-sync-coverage.mjs"]);
run("mutations",process.execPath,["tools/smart-scm-created-po-sync-mutations.mjs"]);
run("reversed",process.execPath,["--test","--test-concurrency=1",...tests.filter(file=>!file.includes("integration/")).reverse()]);
run("lint","node_modules/.bin/eslint",[
  "--config","tools/smart-scm-created-po-sync-eslint.config.mjs","--format","json",...files,
  ...tests.filter(file=>/smart-scm-created-po|scm-netsuite-po-version|integration\/smart-scm-vendor-unit-price/.test(file)),
  "tools/smart-scm-created-po-sync-mutations.mjs","tools/smart-scm-created-po-sync-gauntlet.mjs"
],{accept:(result)=>{
  const messages=JSON.parse(result.stdout).flatMap(file=>file.messages.map(message=>({...message,filePath:file.filePath})));
  const unexpected=messages.filter(message=>!(message.filePath.endsWith("/src/smart-scm-vendor-workflow-repository.js")
    && message.ruleId==="no-unused-vars" && message.message==="'WORKFLOW_KINDS' is assigned a value but never used."));
  return unexpected.length===0;
}});
for(const file of [...files,"src/server.js","public/scm-smart-vendor.js","public/scm-netsuite-po.js"]) {
  run(`syntax-${file.replaceAll("/","-")}`,process.execPath,["--check",file]);
}
run("types","node_modules/.bin/tsc",["--project","tsconfig.mbt.json","--noEmit","--pretty","false"],{accept:(_result,output)=>{
  const baseline=JSON.parse(readFileSync("test/smart-scm-created-po-sync-baseline-types.json","utf8"));
  const errors=output.split("\n").filter(line=>line.includes("error TS")).sort();
  return errors.every(error=>baseline.includes(error));
}});
run("secrets",process.execPath,["test/support/scan-diff-secrets.mjs",...files,"public/scm-smart-vendor.js","public/scm-netsuite-po.js",...tests.filter(file=>file.startsWith("test/"))]);
if(!process.argv.includes("--focused")) {
  run("full","npm",["test"],{accept:(result,output)=>{
    const baseline=JSON.parse(readFileSync("test/smart-scm-created-po-sync-baseline-failures.json","utf8"));
    const failures=[...new Set([...output.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(match=>match[1]))].sort();
    return (result.status===0 || failures.length>0) && failures.every(name=>baseline.includes(name));
  }});
}
console.log("Created PO synchronization verification completed.");
