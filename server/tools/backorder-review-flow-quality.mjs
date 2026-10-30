import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Linter} from 'eslint';
import coverageLibrary from 'istanbul-lib-coverage';
import v8ToIstanbul from 'v8-to-istanbul';
import {scanTextForSecrets,scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

export const runtime=['public/backorder-review-policy.js','public/backorder-stock-requests.js',
  'src/backorder-request-service.js','public/sales-stock-requests.js','public/scm-stock-requests.js',
  'public/sales-stock-requests.html','public/scm-stock-requests.html'];
const out='/app/test-artifacts/backorder-review';
const hash=source=>createHash('sha256').update(source).digest('hex');
export function sourceHashes(){return Object.fromEntries(runtime.map(file=>[file,hash(readFileSync(file))]));}
function diff(file) {
  const before='/app/review-before/'+file;
  const result=spawnSync('diff',['-U0','--label','a/'+file,'--label','b/'+file,existsSync(before)?before:'/dev/null',file],{encoding:'utf8'});
  assert([0,1].includes(result.status),result.stderr);return result.stdout;
}
export function staticChecks(fresh) {
  const globals=Object.fromEntries(['window','document','localStorage','sessionStorage','fetch','setTimeout','clearTimeout','setInterval','clearInterval','console','URL','URLSearchParams','Intl','location','navigator','EventSource','FormData','Option','structuredClone','Blob','Image','requestAnimationFrame','cancelAnimationFrame','CSS','performance','AbortController','MutationObserver','ResizeObserver','crypto','indexedDB','FileReader','alert','confirm','prompt','getComputedStyle','Response','Headers','File','Element','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','CustomEvent','Event','process','Buffer','innerWidth','scmStockState'].map(key=>[key,'readonly']));
  const rules=Object.fromEntries(['no-undef','no-unreachable','no-dupe-args','no-dupe-keys','no-duplicate-case','valid-typeof','no-import-assign','no-unsafe-finally'].map(key=>[key,'error']));
  const linter=new Linter(),result={syntax:0,newLint:0,secrets:[],versions:{},types:null};
  const support=[...fresh,'tools/backorder-review-flow-checks.mjs','tools/backorder-review-flow-quality.mjs',
    'tools/backorder-review-flow-test.sh','tools/backorder-review-flow-release.py','test/backorder-review-flow-spec.md'];
  for(const file of [...runtime,...support]) {
    const source=readFileSync(file,'utf8'),before='/app/review-before/'+file;
    if(/\.m?js$/.test(file)) {
      const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
      assert.equal(syntax.status,0,syntax.stderr);result.syntax++;
      const check=text=>linter.verify(text,{languageOptions:{ecmaVersion:'latest',sourceType:'module',globals},rules});
      const old=existsSync(before)?check(readFileSync(before,'utf8')).map(d=>d.ruleId+':'+d.message):[];
      const added=check(source).filter(d=>{const i=old.indexOf(d.ruleId+':'+d.message);if(i<0)return true;old.splice(i,1);return false;});
      assert.deepEqual(added,[],file+' added lint findings');
    }
    result.secrets.push(...(existsSync(before)?scanUnifiedDiff(diff(file)):scanTextForSecrets(source,file)));
  }
  const types=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--ignoreConfig','--allowJs','--checkJs','--noEmit',
    '--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/backorder-review-policy.js'],{encoding:'utf8',timeout:60000});
  assert.equal(types.status,0,types.stdout+types.stderr);result.types='passed (new shared policy)';
  assert.deepEqual(result.secrets,[]);
  for(const name of ['typescript','eslint','fast-check','c8','@playwright/test','pg'])result.versions[name]=JSON.parse(readFileSync(`node_modules/${name}/package.json`,'utf8')).version;
  return result;
}

export function mutations(suite) {
  const source=readFileSync('public/backorder-review-policy.js','utf8');
  const mutants=[
    ['one reply unlocks all materials','lines.every(hasBackorderScmReply)','lines.some(hasBackorderScmReply)'],
    ['eligible active requests rejected',"detail.stage !== 'completed'","detail.stage === 'completed'"],
    ['Already Ordered compatibility removed',"if (lines.some(line => line.supplyStatus === 'already_ordered')) return true;", "if (lines.some(line => line.supplyStatus === 'already_ordered')) return false;"],
    ['unsaved status treated as SCM reply','line.supplyStatus && (line.stockCheckedAt || line.respondedAt || line.responseRevision > 0)','line.supplyStatus'],
    ['pending Sales confirmation hidden',"['accepted', 'request_update', 'declined', 'closed']","['pending', 'accepted', 'request_update', 'declined', 'closed']"]
  ];
  const results=[];
  for(const [index,[name,needle,replacement]] of mutants.entries()) {
    assert.equal(source.split(needle).length,2,name);
    const loader=`${out}/mutant-${index}.mjs`;
    writeFileSync(loader,`export async function load(url,context,next){const result=await next(url,context);if(url.endsWith('/public/backorder-review-policy.js'))return {...result,source:result.source.toString().replace(${JSON.stringify(needle)},${JSON.stringify(replacement)})};return result;}\n`);
    for(const propertiesOnly of [false,true]) {
      const result=suite(`mutant-${index}-${propertiesOnly?'properties':'unit'}`,['test/mbt/unit/backorder-review-flow.test.js'],
        ['--experimental-loader='+loader,...(propertiesOnly?['--test-name-pattern=generated']:[])],false);
      assert(result.exit===1 && result.fail>0 && !result.cancelled,`${name} survived`);
      results.push({name,propertiesOnly,killed:true});
    }
  }
  return results;
}

export async function coverage() {
  const dir=out+'/coverage';mkdirSync(dir,{recursive:true});writeFileSync(out+'/c8rc.json','{}');
  const files=runtime.slice(0,3);
  const result=spawnSync(process.execPath,['node_modules/c8/bin/c8.js','--config='+out+'/c8rc.json','--all=false','--check-coverage=false',
    '--temp-directory='+out+'/v8','--reports-dir='+dir,'--reporter=json',...files.map(file=>'--include='+file),'report'],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const map=coverageLibrary.createCoverageMap(JSON.parse(readFileSync(dir+'/coverage-final.json','utf8')));
  for(const name of readdirSync(out+'/v8').filter(name=>name.startsWith('browser-'))) {
    for(const entry of JSON.parse(readFileSync(out+'/v8/'+name,'utf8')).result) {
      const path=new URL(entry.url).pathname,file=path.replace('/app/','');
      if(!files.includes(file))continue;
      const source=readFileSync(file,'utf8');assert.equal(entry.source,source,'Browser source drift');
      const converter=v8ToIstanbul(path,0,{source});await converter.load();
      converter.applyCoverage([{functionName:'',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:source.length,count:0}]},...entry.functions]);
      map.merge(converter.toIstanbul());
    }
  }
  return files.map(file=>{
    const changed=new Set();
    for(const match of diff(file).matchAll(/^@@ -[^+]*\+(\d+)(?:,(\d+))? @@/gm)) {
      const first=Number(match[1]),count=Number(match[2]??1);for(let line=first;line<first+count;line++)changed.add(line);
    }
    assert(map.files().includes('/app/'+file),'No coverage for '+file);
    const cov=map.fileCoverageFor('/app/'+file),lines=cov.getLineCoverage();
    const executable=[...changed].filter(line=>line in lines),uncovered=executable.filter(line=>!lines[line]);
    return {file,changedExecutable:executable.length,covered:executable.length-uncovered.length,uncovered,branches:cov.toSummary().branches};
  });
}
