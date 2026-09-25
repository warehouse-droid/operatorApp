import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync,readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { createRequire } from 'node:module';

if(process.env.MBT_TEST_ISOLATED!=='1'||!process.env.DATABASE_URL?.includes('/mbt_test_field_sales')){throw new Error('Use the disposable Field Sales database.');}
const output=resolve(process.env.FIELD_SALES_ARTIFACT_DIR||'test-artifacts/field-sales/final');mkdirSync(output,{recursive:true});
const results=[];
function files(path){return readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(path,entry.name)):[join(path,entry.name)]);}
const testFiles=files('test/field-sales').filter(path=>path.endsWith('.test.js')).sort();
const owned=[...files('src/field-sales'),...files('public/field-sales'),...files('test/field-sales'),...files('tools').filter(path=>/\/field-sales-[^/]+\.(mjs|sh)$/.test(path)),'netsuite-field-sales-restlet.js','migrations/210_field_sales.sql'];
const shared=['package.json','package-lock.json','Dockerfile','Dockerfile.test','src/auth-repository.js','src/server.js','src/netsuite.js','public/control.js','public/app-sidebar.js','public/dispatch-auth.js','public/service-worker.js','test/mbt/infrastructure/production-runtime-contract.test.js','test/mbt/unit/operations-navigation-enhancements.test.js'];
const sourceFiles=[...owned,...shared].sort();
const fingerprint=()=>{const hash=createHash('sha256');for(const path of sourceFiles){hash.update(path+'\0');hash.update(readFileSync(path));}return hash.digest('hex');};
const before=fingerprint();
function run(name,command,args,extra={}) {
  const started=Date.now(),result=spawnSync(command,args,{env:{...process.env,...extra.env},encoding:'utf8',maxBuffer:64*1024*1024,timeout:extra.timeout||180000});
  writeFileSync(join(output,name+'.log'),(result.stdout||'')+(result.stderr||'')+(result.error?String(result.error):''));
  const passed=!result.error&&(extra.allowed||[0]).includes(result.status);results.push({name,command:[command,...args],status:result.status,passed,durationMs:Date.now()-started});
  console.log(`${passed?'PASS':'FAIL'} ${name}`);return result;
}
const node=process.execPath;
run('lint',node,['node_modules/eslint/bin/eslint.js','--config','tools/field-sales-eslint.config.mjs',...owned.filter(path=>/\.(js|mjs)$/.test(path))]);
run('types',node,['node_modules/typescript/bin/tsc','--allowJs','--checkJs','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--strict','--skipLibCheck','public/field-sales/domain.js']);
run('coverage',node,['node_modules/c8/bin/c8.js','--all','--include=src/field-sales/**/*.js','--include=public/field-sales/domain.js','--reporter=text','--reporter=json-summary','--reporter=json',`--report-dir=${join(output,'coverage')}`,`--temp-directory=${join(output,'v8')}`,node,'--test','--test-concurrency=1',...testFiles]);
run('mutations',node,['tools/field-sales-mutations.mjs']);
let seed=20260918;const shuffled=[...testFiles];
for(let i=shuffled.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const j=seed%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
for(const [i,path] of shuffled.entries()){run(`health-${String(i+1).padStart(2,'0')}`,node,['--test',path]);}
run('browser',node,['tools/field-sales-browser.mjs']);
run('server-smoke',node,['tools/field-sales-smoke.mjs']);
const full=run('full-suite',node,['test/support/run-node-tests.mjs','infrastructure','unit','contracts','property','integration','adversarial','concurrency'],{env:{DATABASE_URL:process.env.DATABASE_URL.replace('/mbt_test_field_sales','/mbt_test')},allowed:[0,1],timeout:2400000});
const baseline=JSON.parse(readFileSync('test/field-sales/baseline-failures.json','utf8'));
const fullOutput=(full.stdout||'')+(full.stderr||'');
const summary=fullOutput.match(/Isolated MBT main run failed in (\d+)\/(\d+) file\(s\): (.+)/);
const failures=summary?summary[3].split(',').map(path=>path.trim().replace(/^\/app\//,'')):[];
const newFailures=failures.filter(path=>!baseline.failedFiles.includes(path));
const failedTests=new Map();let currentFile;
for(const line of fullOutput.split('\n')){
  const file=line.match(/^\[isolation\] MBT main \d+\/\d+ \/app\/(test\/.+)/);if(file){currentFile=file[1];}
  const failure=line.match(/^\s*✖ (.+) \([\d.]+m?s\)$/);
  if(failure&&currentFile){failedTests.set(`${currentFile}\0${failure[1]}`,{file:currentFile,name:failure[1]});}
}
const originalTests=new Set(baseline.failedTests.map(failure=>`${failure.file}\0${failure.name}`));
const newFailedTests=[...failedTests].filter(([key])=>!originalTests.has(key)).map(([,value])=>value);
const comparison={baselineFilesRun:baseline.filesRun,baselineFailures:baseline.failedFiles.length,baselineFailedTests:baseline.failedTests.length,failedFiles:failures,newFailures,failedTests:[...failedTests.values()],newFailedTests,summary:summary?.[0]||null};
writeFileSync(join(output,'baseline-comparison.json'),JSON.stringify(comparison,null,2));
results.push({name:'zero-new-regressions',passed:newFailures.length===0&&newFailedTests.length===0&&(full.status===0||Boolean(summary))});
const audit=run('dependency-audit','npm',['audit','--omit=dev','--package-lock-only','--json'],{allowed:[0,1]});
let auditData;try{auditData=JSON.parse(audit.stdout);}catch{auditData={};}
const require=createRequire(import.meta.url),packages=new Map();
function dependency(name,from=require) {
  if(packages.has(name)){return;}
  let directory=dirname(from.resolve(name)),info;
  while(directory!==dirname(directory)){
    const path=join(directory,'package.json');if(existsSync(path)){const candidate=JSON.parse(readFileSync(path,'utf8'));if(candidate.name===name){info=candidate;break;}}directory=dirname(directory);
  }
  if(!info){throw new Error(`Cannot inspect dependency ${name}.`);}
  const evidence={name,version:info.version,license:info.license,licenseSource:'package.json'};
  if(!evidence.license){
    for(const file of readdirSync(directory).filter(value=>/^licen[cs]e(?:\.[^.]+)?$/i.test(value))){
      const content=readFileSync(join(directory,file),'utf8');
      if(/^MIT License\s/m.test(content)&&/Permission is hereby granted, free of charge/.test(content)&&/copyright notice and this permission notice shall be included/.test(content)){
        evidence.license='MIT';evidence.licenseSource=file;evidence.licenseSha256=createHash('sha256').update(content).digest('hex');break;
      }
    }
  }
  packages.set(name,evidence);
  const childRequire=createRequire(join(directory,'package.json'));for(const child of Object.keys(info.dependencies||{})){dependency(child,childRequire);}
}
dependency('pdfkit');
const newDependencyAdvisories=Object.keys(auditData.vulnerabilities||{}).filter(name=>packages.has(name));
const allowedLicense=/^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2.0|Zlib)$/;
const licenseIssues=[...packages.values()].filter(p=>!allowedLicense.test(String(p.license)));
writeFileSync(join(output,'dependencies.json'),JSON.stringify({added:[...packages.values()],auditSummary:auditData.metadata?.vulnerabilities,newDependencyAdvisories,licenseIssues},null,2));
results.push({name:'new-dependency-security',passed:Boolean(auditData.metadata)&&newDependencyAdvisories.length===0&&licenseIssues.length===0});
const secretPattern=/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:sk-proj-|ghp_)[A-Za-z0-9_-]{20,})/;
const secretMatches=owned.filter(path=>secretPattern.test(readFileSync(path,'utf8')));results.push({name:'new-file-secret-scan',passed:secretMatches.length===0});
const after=fingerprint();results.push({name:'unchanged-tested-source',passed:before===after});
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
const versions=Object.fromEntries(['@playwright/test','c8','eslint','fast-check','typescript','pdfkit'].map(name=>[name,lock.packages[`node_modules/${name}`]?.version]));
const report={sourceSha256:after,sourceFiles,node:process.version,versions,healthOrderSeed:20260918,healthOrder:shuffled,secretMatches,results,passed:results.every(r=>r.passed)};
writeFileSync(join(output,'checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,sourceSha256:after,failed:results.filter(r=>!r.passed).map(r=>r.name)}));
if(!report.passed){process.exitCode=1;}
