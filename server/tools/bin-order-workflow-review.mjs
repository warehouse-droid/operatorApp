import {spawnSync} from "node:child_process";
const steps=[
  ["static",process.execPath,["tools/bin-order-workflow-static.mjs"]],
  ["coverage",process.execPath,["tools/bin-order-workflow-coverage.mjs"]],
  ["diagram",process.execPath,["tools/bin-order-workflow-document.cjs"]]
];
let failed=false;
for(const [name,command,args] of steps) {
  console.log(`Review: ${name}`);
  const result=spawnSync(command,args,{stdio:"inherit",env:process.env});
  if(result.status!==0) failed=true;
}
if(failed) process.exitCode=1;
