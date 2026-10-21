import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files=JSON.parse(readFileSync("tools/direct-ship-files.json","utf8"))
  .filter(file=>file.endsWith(".js")&&!file.startsWith("public/"));
const result=spawnSync(process.execPath,["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false",
  ...files.map(file=>`--include=${file}`),"--temp-directory=/tmp/direct-ship-c8","--report-dir=test-artifacts/coverage",
  "--reporter=text","--reporter=json","--reporter=json-summary",process.execPath,"tools/direct-ship-suites.mjs"],
  {stdio:"inherit",env:process.env});
process.exitCode=result.status??1;
