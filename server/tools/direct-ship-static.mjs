import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
const files=JSON.parse(readFileSync("tools/direct-ship-files.json","utf8"))
  .filter(file=>file.endsWith(".js")&&!file.startsWith("public/")&&existsSync(file));
for (const file of files) {
  const checked=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
  if (checked.status!==0) {throw new Error(checked.stderr);}
}
for (const [name,command,args] of [
  ["lint","node_modules/.bin/eslint",["--config","tools/direct-ship-eslint.config.mjs","--format","json",...files]],
  ["types","node_modules/.bin/tsc",["--project","tsconfig.mbt.json","--noEmit","--pretty","false"]]
]) {
  const checked=spawnSync(command,args,{encoding:"utf8",maxBuffer:40*1024*1024});
  if (checked.error||checked.stderr) {throw checked.error||new Error(checked.stderr);}
  writeFileSync(`test-artifacts/${name}.log`,checked.stdout);
  console.log(JSON.stringify({name,exitCode:checked.status,syntaxFiles:files.length}));
}
