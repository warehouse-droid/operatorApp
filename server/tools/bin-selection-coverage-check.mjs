import {spawnSync} from "node:child_process";
const steps=[
  ["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false","--include=src/**/*.js","--include=public/*.js",
    "--temp-directory=test-artifacts/bin-selection-c8","--report-dir=test-artifacts/bin-selection-coverage","--reporter=json",
    "node","tools/bin-order-workflow-suites.mjs","focused"],
  ["tools/bin-selection-coverage.mjs"]
];
for(const args of steps) {
  const r=spawnSync(process.execPath,args,{stdio:"inherit",env:{...process.env,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
  if(r.status)process.exitCode=1;
}
