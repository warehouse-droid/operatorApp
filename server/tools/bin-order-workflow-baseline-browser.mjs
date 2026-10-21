import {cpSync,mkdtempSync,mkdirSync,symlinkSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";

const root=mkdtempSync("/tmp/bin-workflow-baseline-browser-");
try {
  for(const dir of ["src","public"]) cpSync(`/workflow-baseline/${dir}`,`${root}/${dir}`,{recursive:true});
  for(const dir of ["contracts","test/support","test/mbt/support"]) cpSync(dir,`${root}/${dir}`,{recursive:true});
  const file="test/mbt/integration/bin-planning-browser.test.js";
  mkdirSync(`${root}/test/mbt/integration`,{recursive:true});cpSync(file,`${root}/${file}`);
  cpSync("package.json",`${root}/package.json`);symlinkSync("/app/node_modules",`${root}/node_modules`);
  const result=spawnSync(process.execPath,["tools/bin-planning-suites.mjs","selected",`${root}/${file}`],
    {stdio:"inherit",env:{...process.env,NODE_OPTIONS:"--require=/app/tools/bin-order-workflow-browser-env.cjs"}});
  process.exitCode=result.status ?? 1;
} finally {rmSync(root,{recursive:true,force:true});}
