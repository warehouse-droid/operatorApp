import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {files,runNode} from "./blanket-auto-resume-suite.mjs";

const artifact=path.resolve("test-artifacts/blanket-auto-resume");
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"blanket-resume-types-"));
const selected=files.filter(file=>file.startsWith("src/"));
const args=["node_modules/typescript/bin/tsc","--allowJs","--checkJs","--noEmit","--skipLibCheck",
  "--module","nodenext","--moduleResolution","nodenext","--target","ES2022",...selected];
try {
  fs.cpSync("src",path.join(scratch,"src"),{recursive:true});
  fs.copyFileSync("package.json",path.join(scratch,"package.json"));
  fs.symlinkSync(path.resolve("node_modules"),path.join(scratch,"node_modules"));
  for(const file of selected)fs.copyFileSync(path.join(artifact,"baseline",file),path.join(scratch,file));
  const baseline=runNode(args,{cwd:scratch,log:`${artifact}/types-baseline.log`});
  const current=runNode(args,{log:`${artifact}/types-current.log`});
  const diagnostics=output=>{
    const result={};
    for(const match of output.matchAll(/^(.+?)\(\d+,\d+\): error (TS\d+:.*)$/gm)) {
      const key=`${match[1]}:${match[2]}`;
      result[key]=(result[key]||0)+1;
    }
    return result;
  };
  const old=diagnostics(baseline.output),now=diagnostics(current.output);
  const added=Object.keys(now).filter(key=>now[key]>(old[key]||0));
  assert.ok(current.status===0||Object.keys(now).length>0,current.output);
  const result={typescript:JSON.parse(fs.readFileSync("node_modules/typescript/package.json","utf8")).version,
    baselineErrors:Object.values(old).reduce((a,b)=>a+b,0),currentErrors:Object.values(now).reduce((a,b)=>a+b,0),added};
  fs.writeFileSync(`${artifact}/types.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  assert.deepEqual(added,[],"No new type diagnostics");
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
