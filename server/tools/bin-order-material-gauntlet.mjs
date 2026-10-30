import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import crypto from "node:crypto";
const files=JSON.parse(readFileSync("tools/bin-order-material-files.json","utf8"));
const hash=file=>crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
process.env.BIN_FEATURE_FILES="tools/bin-order-material-files.json";
const source=Object.fromEntries(files.map(file=>[file,hash(file)]));
const steps=[
  ["static",["tools/bin-selection-static.mjs"]],
  ["tests",["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false","--include=src/**/*.js","--include=public/*.js",
    "--temp-directory=test-artifacts/bin-selection-c8","--report-dir=test-artifacts/bin-selection-coverage",
    "--reporter=json","--reporter=json-summary","node","tools/bin-order-workflow-suites.mjs","all"]],
  ["mutations",["tools/bin-order-material-mutations.mjs"]],
  ["reverse-order",["tools/bin-order-workflow-suites.mjs","focused"],{BIN_PLANNING_REVERSE:"1"}],
  ["coverage",["tools/bin-selection-coverage.mjs"]]
];
const results=[];
for(const [name,args,environment] of steps) {
  console.log(`Starting BIN order material ${name}`);
  const start=Date.now();
  const result=spawnSync(process.execPath,args,{encoding:"utf8",maxBuffer:32*1024*1024,
    env:{...process.env,...environment,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
  const output=result.stdout+result.stderr;writeFileSync(`test-artifacts/bin-selection-${name}.log`,output);
  results.push({name,exitCode:result.status,durationMs:Date.now()-start,summary:output.split("\n").filter(l=>l.startsWith("Isolated "))});console.log(JSON.stringify(results.at(-1)));
  if (result.status) console.log(output.slice(-7000));
  else if(name==="tests" || name==="reverse-order") console.log(output.split("\n").filter(l=>l.startsWith("Isolated ")).join("\n"));
  else console.log(output.slice(-8000));
}
const drift=files.filter(file=>hash(file)!==source[file]);
const packages=["typescript","eslint","c8","fast-check","playwright","pg"];
const report={createdAt:new Date().toISOString(),sourceHashes:source,sourceDrift:drift,
  toolchain:{node:process.version,...Object.fromEntries(packages.map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`,"utf8")).version]))},steps:results};
writeFileSync("test-artifacts/bin-selection-gauntlet.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(drift.length || results.some(r=>r.exitCode!==0)) process.exitCode=1;
