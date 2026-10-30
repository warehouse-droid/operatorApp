import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import crypto from "node:crypto";
const files=JSON.parse(readFileSync("tools/bin-collection-request-files.json","utf8"));
const hash=file=>crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
process.env.BIN_FEATURE_FILES="tools/bin-collection-request-files.json";
const source=Object.fromEntries(files.map(file=>[file,hash(file)]));
const steps=[
  ["baseline",["tools/bin-collection-request-baseline.mjs"]],
  ["static",["tools/bin-selection-static.mjs"]],
  ["tests",["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false","--include=src/**/*.js","--include=public/*.js",
    "--temp-directory=test-artifacts/bin-selection-c8","--report-dir=test-artifacts/bin-selection-coverage",
    "--reporter=json","--reporter=json-summary","node","tools/bin-collection-request-suites.mjs","all"]],
  ["mutations",["tools/bin-collection-request-mutations.mjs"]],
  ["reverse-order",["tools/bin-collection-request-suites.mjs","focused"],{BIN_PLANNING_REVERSE:"1"}],
  ["coverage",["tools/bin-collection-request-coverage.mjs","--require-complete"]]
];
const results=[];
for(const [name,args,environment] of steps) {
  console.log(`Starting BIN collection and price ${name}`);
  const start=Date.now();
  const result=spawnSync(process.execPath,args,{encoding:"utf8",maxBuffer:32*1024*1024,
    env:{...process.env,...environment,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
  const output=result.stdout+result.stderr;writeFileSync(`test-artifacts/bin-selection-${name}.log`,output);
  const failures=[...new Set(output.split("\n").filter(l=>l.startsWith("✖ ")&&!l.startsWith("✖ failing tests:")).map(l=>l.slice(2).replace(/ \([\d.]+ms\)$/u,"")))];
  let exitCode=result.status,baselineFailures=[];
  if(name==="tests" && exitCode===1 && results.find(r=>r.name==="baseline")?.exitCode===0) {
    const baseline=JSON.parse(readFileSync('test-artifacts/bin-collection-baseline.json','utf8'));
    if(JSON.stringify(failures)===JSON.stringify(baseline.failures) && output.split('\n').some(l=>/^Isolated .* failed in 1\/\d+ file\(s\): /u.test(l)&&l.endsWith(baseline.file))) {
      exitCode=0;baselineFailures=failures;
    }
  }
  const count=kind=>[...output.matchAll(new RegExp(`^ℹ ${kind} (\\d+)$`,'gmu'))].reduce((n,m)=>n+Number(m[1]),0);
  results.push({name,exitCode,rawExitCode:result.status,baselineFailures,tests:count('tests'),passed:count('pass'),failed:count('fail'),durationMs:Date.now()-start,summary:output.split("\n").filter(l=>l.startsWith("Isolated ")),failures});console.log(JSON.stringify(results.at(-1)));
  if (exitCode) console.log(output.slice(-7000));
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
