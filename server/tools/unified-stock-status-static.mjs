import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Linter} from 'eslint';
import {scanTextForSecrets,scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

const out='test-artifacts/unified-stock-status',before=out+'/before';
const runtime=JSON.parse(readFileSync('tools/unified-stock-status-files.json','utf8'));
const support=['tools/unified-stock-status-static.mjs','tools/unified-stock-status-gauntlet.mjs','tools/unified-stock-status-mutations.mjs','tools/unified-stock-status-coverage.mjs','tools/unified-stock-status-baseline.mjs','tools/unified-stock-status-snapshot.mjs',
  'test/mbt/unit/regular-stock-status.test.js','test/mbt/property/regular-stock-status.property.test.js','test/mbt/integration/regular-stock-status.test.js',
  'test/mbt/integration/regular-stock-resolution-browser.test.js'];
const report={syntax:[],lint:[],secrets:[],hashes:{}};
const names=['window','document','localStorage','sessionStorage','fetch','setTimeout','clearTimeout','setInterval','clearInterval','console','URL','URLSearchParams','Intl',
  'location','navigator','EventSource','FormData','Option','structuredClone','Blob','Image','requestAnimationFrame','cancelAnimationFrame','CSS','performance',
  'AbortController','MutationObserver','ResizeObserver','crypto','indexedDB','FileReader','alert','confirm','prompt','getComputedStyle','Response','Headers','File','Element',
  'HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','CustomEvent','process','Buffer'];
const globals=Object.fromEntries(names.map(name=>[name,'readonly']));
const rules=Object.fromEntries(['no-undef','no-unreachable','no-dupe-args','no-dupe-keys','no-duplicate-case','valid-typeof','no-import-assign','no-unsafe-finally'].map(name=>[name,'error']));
const lint=new Linter();
for(const file of [...runtime,...support]){
  const source=readFileSync(file,'utf8');report.hashes[file]=createHash('sha256').update(source).digest('hex');
  if(/\.m?js$/.test(file)){
    const syntax=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);report.syntax.push(file);
    const verify=text=>lint.verify(text,{languageOptions:{ecmaVersion:'latest',sourceType:'module',globals},rules});
    const baseline=existsSync(`${before}/${file}`)?verify(readFileSync(`${before}/${file}`,'utf8')):[];
    const current=verify(source),remaining=baseline.map(d=>`${d.ruleId}:${d.message}`);
    const added=current.filter(d=>{const i=remaining.indexOf(`${d.ruleId}:${d.message}`);if(i<0)return true;remaining.splice(i,1);return false;});
    report.lint.push({file,baseline:baseline.length,current:current.length,added});
  }
  if(existsSync(`${before}/${file}`)){
    const diff=spawnSync('diff',['-U0','--label','a/'+file,'--label','b/'+file,`${before}/${file}`,file],{encoding:'utf8'});
    assert([0,1].includes(diff.status),diff.stderr);report.secrets.push(...scanUnifiedDiff(diff.stdout));
  }else report.secrets.push(...scanTextForSecrets(source,file));
}
const types=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','--ignoreConfig','--allowJs','--noEmit','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','public/regular-stock-status.js'],{encoding:'utf8',timeout:60000});
report.types={scope:'shared pure status model (@ts-check)',exit:types.status,output:types.stdout+types.stderr};
writeFileSync(`${out}/static.json`,JSON.stringify(report,null,2));
assert.equal(types.status,0,report.types.output);
assert(report.lint.every(row=>!row.added.length),'New lint diagnostics; see static.json');
assert.equal(report.secrets.length,0,'Secret findings; see static.json');
console.log(JSON.stringify({syntax:report.syntax.length,newLint:0,newTypes:0,secrets:0}));
