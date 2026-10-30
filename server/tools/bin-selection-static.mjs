import {spawnSync} from "node:child_process";
import {readFileSync,writeFileSync,existsSync,mkdirSync,cpSync,symlinkSync,rmSync} from "node:fs";
import {ESLint} from "eslint";
import {scanUnifiedDiff} from "../test/support/scan-diff-secrets.mjs";
const files=JSON.parse(readFileSync(process.env.BIN_FEATURE_FILES || "tools/bin-selection-files.json","utf8")).filter(f=>f.endsWith(".js"));
const baseline="/app/test-artifacts/bin-selection-baseline",typeRoot="/tmp/bin-selection-types";
const mbtLint=new ESLint({overrideConfigFile:"eslint.mbt.config.js"});
const browserLint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:["public/**/*.js"],
  languageOptions:{ecmaVersion:"latest",sourceType:"script",globals:{window:"readonly",document:"readonly",crypto:"readonly",fetch:"readonly",globalThis:"readonly"}},
  rules:{eqeqeq:"error","no-undef":"error","no-unreachable":"error","no-constant-condition":"error","no-unused-vars":["error",{argsIgnorePattern:"^_"}],"no-var":"error","prefer-const":"error"}}]});
function difference(before,after,key) {
  const counts=new Map();for (const m of before) counts.set(key(m),(counts.get(key(m))||0)+1);
  return after.filter(m=>{const k=key(m),n=counts.get(k)||0;if(n){counts.set(k,n-1);return false;}return true;});
}
const lint=[];
const changes=JSON.parse(readFileSync("test-artifacts/bin-selection-changed-lines.json","utf8"));
const secretFindings=[];
for(const [file,lines] of Object.entries(changes)) {
  const source=readFileSync(file,"utf8").split("\n");
  const diff=`+++ b/${file}\n`+lines.map(n=>`@@ -0,0 +${n},1 @@\n+${source[n-1]}`).join("\n");
  secretFindings.push(...scanUnifiedDiff(diff));
}
for (const file of files) {
  const syntax=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});if(syntax.status) throw new Error(syntax.stderr);
  if (!file.startsWith("src/mbt/") && !file.startsWith("public/")) continue;
  const checker=file.startsWith("public/") ? browserLint : mbtLint;
  const current=(await checker.lintFiles([file]))[0].messages;
  const before=existsSync(`${baseline}/${file}`) ? (await checker.lintText(readFileSync(`${baseline}/${file}`,"utf8"),{filePath:file}))[0].messages : [];
  lint.push(...difference(before,current,m=>`${m.ruleId}:${m.message}`).map(m=>({file,line:m.line,message:m.message})));
}
const roots=files.filter(f=>f.startsWith("src/mbt/"));
mkdirSync(typeRoot,{recursive:true});cpSync("src",`${typeRoot}/src`,{recursive:true});
cpSync("package.json",`${typeRoot}/package.json`);symlinkSync("/app/node_modules",`${typeRoot}/node_modules`);
if (existsSync(`${baseline}/src`)) cpSync(`${baseline}/src`,`${typeRoot}/src`,{recursive:true});
const options={allowJs:true,checkJs:false,noEmit:true,strict:true,skipLibCheck:true,noUncheckedIndexedAccess:true,
  exactOptionalPropertyTypes:true,noImplicitReturns:true,target:"ES2023",module:"NodeNext",moduleResolution:"NodeNext",types:["node"],typeRoots:["/app/node_modules/@types"]};
function types(before) {
  const root=before ? typeRoot : "/app",config=`/tmp/bin-selection-${before ? "before" : "after"}.json`;
  writeFileSync(config,JSON.stringify({compilerOptions:options,files:roots.filter(f=>!before || existsSync(`${baseline}/${f}`)).map(f=>`${root}/${f}`)}));
  const result=spawnSync(process.execPath,["node_modules/typescript/lib/tsc.js","--project",config,"--pretty","false"],{encoding:"utf8",maxBuffer:32*1024*1024});
  if (result.error || result.signal) throw new Error(`Type checker failed: ${result.error || result.signal}`);
  return (result.stdout+result.stderr).split("\n").filter(l=>/error TS\d+/u.test(l)).map(line=>{
    const match=line.match(/^(.*?)\((\d+),\d+\): error (TS\d+): (.*)$/u);
    return match ? {file:match[1].replace(`${root}/`,"").replace(/^\.\.\/tmp\/bin-selection-types\//u,""),line:Number(match[2]),code:match[3],message:match[4]} : {file:"compiler",message:line};
  }).filter(d=>roots.includes(d.file) || d.file==="compiler");
}
try {
  const before=types(true),after=types(false),introduced=difference(before,after,m=>`${m.file}:${m.code}:${m.message}`);
  const report={syntaxFiles:files.length,newLintErrors:lint,newTypeErrors:introduced,baselineTypeErrors:before.length,secretFindings};
  writeFileSync("test-artifacts/bin-selection-static.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  if (lint.length || introduced.length || secretFindings.length) process.exitCode=1;
} finally {rmSync(typeRoot,{recursive:true,force:true});}
