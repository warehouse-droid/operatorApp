import {readdirSync} from "node:fs";
import {runNodeTestFilesIsolated} from "../test/support/test-database-isolation.mjs";

const mode=process.argv[2] || "all";
const files=[];
for (const directory of ["unit","integration","concurrency","property","adversarial"]) {
  for (const file of readdirSync(`test/mbt/${directory}`).sort()) {
    const workflow=file.startsWith("bin-order-workflow");
    const baseline=/^(bin-dispatch|bin-contract|bin-leg|dispatch-bin|driver-bin|frontdesk-bin|frontdesk-multibin)/u.test(file);
    const planning=file.startsWith("bin-planning-");
    const billing=/^(shadow-billing|billing-read-model|multibin-billing-isolation)/u.test(file);
    if (file.endsWith(".test.js") && (workflow || (mode==="all" && (baseline || planning || billing)))) {
      files.push(`test/mbt/${directory}/${file}`);
    }
  }
}
if (process.env.BIN_PLANNING_REVERSE==="1") files.reverse();
process.exitCode=await runNodeTestFilesIsolated(files,{label:`bin-workflows-${mode}`,
  environment:{...process.env,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
