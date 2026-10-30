import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import crypto from 'node:crypto';
import {ESLint} from 'eslint';
import coverageLib from 'istanbul-lib-coverage';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';
const runtime=JSON.parse(readFileSync('tools/dispatch-sales-pickup-files.json'));
const sources=runtime.filter(file=>file.endsWith('.js'));
const artifact=resolve('test-artifacts/dispatch-sales-pickup');mkdirSync(artifact,{recursive:true});
const report={sourceHashes:Object.fromEntries(runtime.map(f=>[f,crypto.createHash('sha256').update(readFileSync(f)).digest('hex')])),
 toolchain:{node:process.version,...Object.fromEntries(['typescript','eslint','c8','fast-check','pg'].map(n=>[n,JSON.parse(readFileSync(`node_modules/${n}/package.json`)).version]))},steps:[],mutations:[]};
function run(name,args,options={}){
 const r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:48*1024*1024,...options});
 const output=(r.stdout||'')+(r.stderr||'');writeFileSync(`${artifact}/${name}.log`,output);
 report.steps.push({name,status:r.status,summaries:output.split('\n').filter(l=>/^(# (tests|pass|fail|skipped)|ℹ (tests|pass|fail|skipped)|Isolated )/u.test(l))});
 console.log(JSON.stringify(report.steps.at(-1)));return {...r,output};
}
const baseline=`${artifact}/baseline`;mkdirSync(baseline,{recursive:true});
for(const folder of ['src','public','test','tools'])cpSync(folder,`${baseline}/${folder}`,{recursive:true});
for(const file of runtime)cpSync(`test-artifacts/source-before/${file}`,`${baseline}/${file}`);
for(const folder of ['migrations','node_modules'])symlinkSync(resolve(folder),`${baseline}/${folder}`);
cpSync('package.json',`${baseline}/package.json`);
const before=run('baseline-regression',['tools/dispatch-sales-pickup-checks.mjs','regression'],{cwd:baseline});
const normalize=l=>l.replaceAll(baseline+'/','').replaceAll(process.cwd()+'/','').replace(/ \([\d.]+ms\)$/u,'');
const failures=output=>[...new Set(output.split('\n').filter(l=>/^✖ /u.test(l)&&l!=='✖ failing tests:').map(normalize))];
const after=run('candidate-suite',['node_modules/c8/bin/c8.js','--all=false','--check-coverage=false',...sources.map(f=>`--include=${f}`),
 '--include=tools/repair-gob122647-empty-pickup.mjs',`--temp-directory=${artifact}/c8`,`--report-dir=${artifact}/coverage`,'--reporter=json','--reporter=json-summary',
 'node','tools/dispatch-sales-pickup-checks.mjs','suite']);
report.regression={baselineFailures:failures(before.output),candidateFailures:failures(after.output)};
report.regression.baselineErrors=[...new Set(before.output.split('\n').filter(l=>/^(?:ReferenceError|TypeError|Error|  AssertionError|  Error):/u.test(l)).map(normalize))];
report.regression.candidateErrors=[...new Set(after.output.split('\n').filter(l=>/^(?:ReferenceError|TypeError|Error|  AssertionError|  Error):/u.test(l)).map(normalize))];
report.regression.newFailures=report.regression.candidateFailures.filter(l=>!report.regression.baselineFailures.includes(l));
let failed=Boolean(report.regression.newFailures.length||(!report.regression.candidateFailures.length&&after.status!==0));
if(failed)console.log(after.output.slice(-18000));
const typeArgs=['node_modules/typescript/lib/tsc.js','--allowJs','--checkJs','--noEmit','--skipLibCheck','--strict','false','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--pretty','false',...sources];
const normalizeTypes=output=>new Set(output.split('\n').filter(l=>sources.some(f=>l.startsWith(f+'('))).map(l=>l.replace(/\(\d+,\d+\)/u,'')));
const oldTypes=run('baseline-types',typeArgs,{cwd:baseline}),newTypes=run('candidate-types',typeArgs);
const typeErrors=[...normalizeTypes(newTypes.output)].filter(l=>!normalizeTypes(oldTypes.output).has(l));
const changes=JSON.parse(readFileSync('test-artifacts/source-changes.json')).changedLines;
const checker=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.{js,mjs}'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{console:'readonly',process:'readonly',Buffer:'readonly',URL:'readonly',setTimeout:'readonly',clearTimeout:'readonly',structuredClone:'readonly',window:'readonly',document:'readonly',navigator:'readonly',fetch:'readonly',AbortController:'readonly',localStorage:'readonly',location:'readonly',requestAnimationFrame:'readonly',CustomEvent:'readonly',HTMLElement:'readonly',setInterval:'readonly',clearInterval:'readonly'}},rules:{'no-undef':'error','no-unreachable':'error','no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'no-var':'error','prefer-const':'error'}}]});
const findings=(await checker.lintFiles(sources)).flatMap(r=>r.messages.filter(m=>changes[relative(process.cwd(),r.filePath)]?.includes(m.line)).map(m=>({file:relative(process.cwd(),r.filePath),line:m.line,message:m.message})));
const syntax=sources.map(file=>({file,status:spawnSync(process.execPath,['--check',file]).status}));
const secrets=sources.flatMap(file=>scanUnifiedDiff(`+++ b/${file}\n@@ -0,0 +1,1 @@\n`+readFileSync(file,'utf8').split('\n').map(l=>'+'+l).join('\n'))
 .filter(finding=>changes[file].includes(finding.line)));
report.static={newTypeErrors:typeErrors,newLintFindings:findings,syntax,secrets};
failed ||= Boolean(typeErrors.length||findings.length||secrets.length||syntax.some(r=>r.status));
if(!failed){
 const map=coverageLib.createCoverageMap(JSON.parse(readFileSync(`${artifact}/coverage/coverage-final.json`)));
 report.changedLineCoverage={covered:0,total:0,uncovered:[],note:'V8 coverage; production function extraction preserves filenames and source offsets via compileFunction.'};
 for(const file of sources){
  if(!map.files().includes(resolve(file))){report.changedLineCoverage.uncovered.push(`${file}: not instrumented`);continue;}
  const lines=map.fileCoverageFor(resolve(file)).getLineCoverage();
  for(const line of changes[file])if(line in lines){report.changedLineCoverage.total++;if(lines[line]>0)report.changedLineCoverage.covered++;else report.changedLineCoverage.uncovered.push(`${file}:${line}`);}
 }
 failed ||= report.changedLineCoverage.uncovered.length>0;
 const mutations=sources.filter(file=>readFileSync(file,'utf8').includes('const knownSales =')).map((file,i)=>[`ignore-sales-${i}`,file,'const knownSales = (item.quantity != null || item.salesQty != null) && Number.isFinite(totalSales);','const knownSales = false;']);
 mutations.push(['skip-recorded-cargo-guard','tools/repair-gob122647-empty-pickup.mjs',"assert.ok(job.job_details.orders.every(o=>Array.isArray(o.items)&&o.items.length===0),'Pickup contains recorded cargo');",'/* mutant: ignore recorded cargo */']);
 mutations.push(['operator-ignore-sales-authority','src/operator-linked-quantity-domain.js',
  'const noYardLoadRequired = original.sales > EPSILON', 'const noYardLoadRequired = false']);
 mutations.push(['operator-server-revive-zero','src/delivery-repository.js',
  'if (positiveQuantity(line.original_quantity) > 0) return positiveQuantity(line.quantity);', '/* mutant: restore packing fallback */']);
 mutations.push(['operator-browser-revive-zero','public/operator.js',
  'if (qty(line.original_quantity) > 0) return qty(line.quantity);', '/* mutant: restore packing fallback */']);
 mutations.push(['operator-ignore-po','src/operator-linked-quantity-domain.js',
  'original[unit] - linkedTotal[unit]', 'original[unit] - directTo[unit]']);
 mutations.push(['operator-ignore-direct-to','src/operator-linked-quantity-domain.js',
  'original[unit] - linkedTotal[unit]', 'original[unit] - po[unit]']);
 for(const [name,file,from,to] of mutations){
  const original=readFileSync(file,'utf8');if(!original.includes(from))throw new Error('Mutation anchor missing: '+name);
  try{writeFileSync(file,original.replace(from,to));const result=run(name,['tools/dispatch-sales-pickup-checks.mjs','focused']);
   const property=run(name+'-properties',['tools/dispatch-sales-pickup-checks.mjs','property']);
   report.mutations.push({name,killed:result.status!==0,propertyKilled:property.status!==0});failed ||= result.status===0;
  }finally{writeFileSync(file,original);}
 }
 failed ||= run('focused-repeat',['tools/dispatch-sales-pickup-checks.mjs','focused']).status!==0;
}
rmSync(baseline,{recursive:true,force:true});
report.passed=!failed;writeFileSync(`${artifact}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));process.exitCode=failed?1:0;
