import fs from 'node:fs/promises';
import v8toIstanbul from 'v8-to-istanbul';
import {mergeScriptCovs} from '@bcoe/v8-coverage';
const scripts=JSON.parse(await fs.readFile('test-artifacts/stock-check/browser-coverage.json','utf8'));
const source=await fs.readFile('public/scm-stock-check.js','utf8');
const merged=mergeScriptCovs(scripts.map(script=>({scriptId:'1',url:'public/scm-stock-check.js',functions:script.functions})));
const converter=v8toIstanbul('public/scm-stock-check.js',0,{source});await converter.load();converter.applyCoverage(merged.functions);
const report=converter.toIstanbul();await fs.writeFile('test-artifacts/stock-check/browser-coverage-istanbul.json',JSON.stringify(report));
const file=Object.values(report)[0],counts=Object.values(file.s),branches=Object.values(file.b).flat();
console.log(JSON.stringify({file:'public/scm-stock-check.js',executedLines:counts.filter(count=>count>0).length,totalLines:counts.length,
  executedBranches:branches.filter(count=>count>0).length,totalBranches:branches.length}));
