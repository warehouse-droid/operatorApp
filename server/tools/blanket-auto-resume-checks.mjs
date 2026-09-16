import fs from "node:fs";
import crypto from "node:crypto";
import {ESLint} from "eslint";
import {files,focused,runNode} from "./blanket-auto-resume-suite.mjs";
import base from "../eslint.mbt.config.js";

const artifact="test-artifacts/blanket-auto-resume";
const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
for(const file of files.filter(file=>file.endsWith(".js"))) {
  const result=runNode(["--check",file]);
  if(result.status)throw new Error(result.output);
}
const globals={...base[0].languageOptions.globals,document:"readonly",window:"readonly",confirm:"readonly"};
for(const file of fs.readdirSync("public").filter(file=>file.startsWith("scm-smart")&&file.endsWith(".js"))) {
  const source=fs.readFileSync(`public/${file}`,"utf8");
  for(const match of source.matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/gm))globals[match[1]||match[2]]="writable";
}
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{
  files:["**/*.{js,mjs}"],languageOptions:{...base[0].languageOptions,globals},
  rules:{"no-undef":"error","no-unused-vars":["error",{argsIgnorePattern:"^_",varsIgnorePattern:"^smart"}],"no-unreachable":"error","eqeqeq":"error","no-var":"error"}
}]});
const lint=[];
for(const file of files.filter(file=>file.endsWith(".js"))) {
  const before=(await eslint.lintText(fs.readFileSync(`${artifact}/baseline/${file}`,"utf8"),{filePath:file}))[0];
  const after=(await eslint.lintFiles(file))[0];
  const counts=rows=>rows.messages.reduce((map,m)=>{const k=`${m.ruleId}:${m.message}`;map[k]=(map[k]||0)+1;return map;},{});
  const old=counts(before),current=counts(after);
  const added=Object.keys(current).filter(k=>current[k]>(old[k]||0));
  lint.push({file,baseline:before.messages.length,current:after.messages.length,added});
  if(added.length)throw new Error(JSON.stringify(lint.at(-1)));
}
const complexity=new ESLint({overrideConfigFile:true,overrideConfig:[{files:["**/*.js"],rules:{complexity:["error",12]}}]});
const source=fs.readFileSync("src/smart-scm-planning-exclusion-repository.js","utf8");
const helper=source.slice(source.indexOf("export async function resumeSmartScmBlanketCoveredPlanningExclusions"),source.indexOf("export async function deactivateSmartScmPlanningExclusion"));
const complexityMessages=(await complexity.lintText(helper,{filePath:"helper.js"}))[0].messages;
if(complexityMessages.length)throw new Error(JSON.stringify(complexityMessages));
fs.writeFileSync(`${artifact}/static.json`,JSON.stringify({node:process.version,hashes,lint,complexityMessages},null,2));
const coverage=runNode(["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false","--reporter=json","--reporter=json-summary",`--report-dir=${artifact}/coverage`,"--include=src/*.js","--include=public/scm-smart-exclusions.js",
  "node","--test","--test-concurrency=1",...focused],{log:`${artifact}/coverage.log`});
if(coverage.status)throw new Error(coverage.output);
console.log(JSON.stringify({syntax:"passed",lint,complexity:"new helper <= 12",coverage:"captured",hashes}));
