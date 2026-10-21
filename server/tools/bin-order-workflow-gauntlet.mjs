import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import crypto from "node:crypto";

const steps=[
  ["static",["tools/bin-order-workflow-static.mjs"]],
  ["tests",["node_modules/c8/bin/c8.js","--all=false","--include=src/mbt/*.js","--include=public/*.js",
    "--temp-directory=/tmp/bin-workflow-final-c8","--report-dir=test-artifacts/workflow-coverage",
    "--reporter=json","--reporter=json-summary","node","tools/bin-order-workflow-suites.mjs","all"]],
  ["legacy-runtime-new-schema",["tools/bin-order-workflow-baseline-browser.mjs"]],
  ["mutations",["tools/bin-order-workflow-mutations.mjs"]],
  ["reverse-order",["tools/bin-order-workflow-suites.mjs","focused"],{BIN_PLANNING_REVERSE:"1"}],
  ["diagram",["tools/bin-order-workflow-document.cjs"]],
  ["coverage",["tools/bin-order-workflow-coverage.mjs","--require-complete"]]
];
const results=[];
for(const [name,args,environment] of steps) {
  const start=Date.now();
  const result=spawnSync(process.execPath,args,{encoding:"utf8",maxBuffer:32*1024*1024,
    env:{...process.env,...environment,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
  writeFileSync(`test-artifacts/final-${name}.log`,result.stdout+result.stderr);
  results.push({name,exitCode:result.status,durationMs:Date.now()-start});
  console.log(JSON.stringify(results.at(-1)));
}
const packages=["typescript","eslint","c8","fast-check","playwright","pg","v8-to-istanbul"];
const source=JSON.parse(readFileSync("test-artifacts/workflow-source-state.json","utf8"));
const drift=[];
for(const [file,hash] of Object.entries(source.files)) {
  if(crypto.createHash("sha256").update(readFileSync(file)).digest("hex")!==hash) drift.push(file);
}
const toolchain=Object.fromEntries(packages.map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,"utf8")).version]));
const report={createdAt:new Date().toISOString(),sourceTreeHash:source.treeHash,sourceDrift:drift,
  toolchain:{node:process.version,...toolchain},steps:results};
writeFileSync("test-artifacts/workflow-gauntlet.json",JSON.stringify(report,null,2));
if(drift.length || results.some(result=>result.exitCode!==0)) process.exitCode=1;
