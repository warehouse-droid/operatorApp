import {spawnSync} from "node:child_process";
const steps=[
  ["workflows",["node_modules/c8/bin/c8.js","--all=false","--include=src/mbt/*.js","--temp-directory=/tmp/bin-workflow-focused",
    "--report-dir=test-artifacts/workflow-focused-coverage","--reporter=json","--reporter=json-summary",
    "node","tools/bin-order-workflow-suites.mjs","focused"]],
  ["planner-browser",["tools/bin-planning-suites.mjs","selected","test/mbt/integration/bin-planning-browser.test.js"]],
  ["static",["tools/bin-order-workflow-static.mjs"]],
  ["diagram",["tools/bin-order-workflow-document.cjs"]]
];
let failed=false;
for(const [name,args] of steps) {
  console.log(`Focused check: ${name}`);
  const result=spawnSync(process.execPath,args,{stdio:"inherit",
    env:{...process.env,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
  if(result.status!==0) failed=true;
}
if(failed) process.exitCode=1;
