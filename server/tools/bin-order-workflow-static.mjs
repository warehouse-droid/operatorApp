import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync,cpSync,mkdirSync,symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";

const files=JSON.parse(readFileSync("tools/bin-order-workflow-files.json","utf8"));
const js=files.filter(f=>f.endsWith(".js"));
for (const file of js) {
  const checked=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
  if (checked.status) throw new Error(`${file}: ${checked.stderr}`);
}
const mbt=js.filter(f=>f.startsWith("src/mbt/"));
const lint=new ESLint({overrideConfigFile:"eslint.mbt.config.js"});
const browserLint=new ESLint({overrideConfigFile:true,overrideConfig:[{
  files:["public/**/*.js"],languageOptions:{ecmaVersion:"latest",sourceType:"script",
    globals:{window:"readonly",document:"readonly",crypto:"readonly",fetch:"readonly"}},
  rules:{"eqeqeq":"error","no-undef":"error","no-unreachable":"error","no-constant-condition":"error",
    "no-unused-vars":["error",{argsIgnorePattern:"^_"}],"no-var":"error","prefer-const":"error"}
}]});
const introduced=[];
const allLint=[];
for (const file of mbt) {
  const current=(await lint.lintFiles([file]))[0];
  const baseline=existsSync(`/workflow-baseline/${file}`)
    ? (await lint.lintText(readFileSync(`/workflow-baseline/${file}`,"utf8"),{filePath:file}))[0] : {messages:[]};
  const counts=new Map();
  const key=m=>`${m.ruleId}:${m.message}`;
  for (const m of baseline.messages) counts.set(key(m),(counts.get(key(m)) || 0)+1);
  for (const m of current.messages) {
    const k=key(m),n=counts.get(k)||0;
    if (n) counts.set(k,n-1);
    else introduced.push({file,...m});
  }
  allLint.push(current);
}
for(const result of await browserLint.lintFiles(["public/bin-order-workflow-ui.js"])) {
  introduced.push(...result.messages.map(message=>({file:"public/bin-order-workflow-ui.js",...message})));
  allLint.push(result);
}
writeFileSync("test-artifacts/workflow-lint.json",JSON.stringify({introduced,allLint},null,2));
const options={allowJs:true,checkJs:false,noEmit:true,strict:true,skipLibCheck:true,
  noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,noImplicitReturns:true,
  target:"ES2023",module:"NodeNext",moduleResolution:"NodeNext",types:["node"],typeRoots:["/app/node_modules/@types"]};
const baselineRoot="/tmp/bin-workflow-types";
mkdirSync(baselineRoot,{recursive:true});
cpSync("/workflow-baseline/src",`${baselineRoot}/src`,{recursive:true});
cpSync("/app/package.json",`${baselineRoot}/package.json`);
symlinkSync("/app/node_modules",`${baselineRoot}/node_modules`);
function diagnostics(baseline) {
  const root=baseline ? baselineRoot : "/app";
  const roots=mbt.filter(f=>!baseline || existsSync(`/workflow-baseline/${f}`)).map(f=>`${root}/${f}`);
  const config=`/tmp/workflow-${baseline ? "before" : "after"}.json`;
  writeFileSync(config,JSON.stringify({compilerOptions:options,files:roots}));
  const result=spawnSync(process.execPath,["/app/node_modules/typescript/lib/tsc.js","--project",config,"--pretty","false"],
    {encoding:"utf8",cwd:root,maxBuffer:16*1024*1024,env:{...process.env,GOMAXPROCS:"2"}});
  const output=result.stdout+result.stderr;
  writeFileSync(`test-artifacts/workflow-types-${baseline ? "before" : "after"}.log`,output);
  if (result.error || result.signal) throw new Error(`Type checker did not complete: ${result.error || result.signal}`);
  const rows=output.split("\n").filter(l=>/error TS\d+/u.test(l)).map(l=>{
    const match=l.match(/^(.*?)\((\d+),\d+\): error TS(\d+): (.*)$/u);
    return match ? {file:resolve(root,match[1]).replace(`${root}/`,""),line:Number(match[2]),code:Number(match[3]),message:match[4]} : {file:"compiler",line:0,code:0,message:l};
  });
  return rows.filter(d=>d.file==="compiler" || mbt.includes(d.file));
}
const before=diagnostics(true),after=diagnostics(false),counts=new Map();
const key=d=>`${d.file}:${d.code}:${d.message}`;
for (const d of before) counts.set(key(d),(counts.get(key(d))||0)+1);
const newTypes=after.filter(d=>{const k=key(d),n=counts.get(k)||0;if(n){counts.set(k,n-1);return false;}return true;});
writeFileSync("test-artifacts/workflow-types.json",JSON.stringify({introduced:newTypes,before,after},null,2));
console.log(JSON.stringify({syntaxFiles:js.length,newLintErrors:introduced.length,newTypeErrors:newTypes.length,
  lint:introduced.map(m=>`${m.file}:${m.line} ${m.message}`),types:newTypes},null,2));
if (introduced.length || newTypes.length) process.exitCode=1;
