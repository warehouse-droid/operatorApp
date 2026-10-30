import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ESLint} from 'eslint';
import coverageLibrary from 'istanbul-lib-coverage';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
import {scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

const changed=['src/sales-order-auto-fulfillment-kits.js','src/sales-order-auto-fulfillment-netsuite-adapter.js',
  'src/sales-order-auto-fulfillment-service.js','src/sales-order-auto-fulfillment-repository.js','src/netsuite.js'];
const primary=['test/mbt/unit/delivery-kit.test.js','test/mbt/integration/delivery-kit.test.js'];
const regression=[...fs.readdirSync('test/mbt/unit').filter(name=>
  /^(operator-netsuite-posting-|operator-kit|operator-direct-orderline|sales-order-auto-fulfillment|sales-delivery-load-fulfillment|noninventory-fulfillment|child-location-|ifir-posting)/.test(name)
  &&name.endsWith('.test.js')).map(name=>`test/mbt/unit/${name}`),
  'test/mbt/property/operator-kit.property.test.js','test/mbt/property/operator-netsuite-posting.property.test.js',
  'test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js','test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js',
  ...['operator-kit','sales-order-auto-fulfillment-migration.red','sales-order-auto-fulfillment-admin-http',
    'sales-delivery-load-fulfillment','noninventory-fulfillment'].map(name=>`test/mbt/integration/${name}.test.js`)];
if(process.argv[2]==='suite') {
  const selection=process.argv[3]==='baseline'?regression:[...primary,...regression];
  process.exitCode=await runNodeTestFilesIsolated(process.argv[3]==='reverse'?selection.reverse():selection,{label:'delivery-kit'});
} else {
  const output=path.resolve('test-artifacts/delivery-kit');fs.mkdirSync(output,{recursive:true});
  const report={tools:{node:process.version},hashes:{}};
  for(const name of ['fast-check','typescript','eslint','c8']) report.tools[name]=JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`)).version;
  for(const name of changed) report.hashes[name]=crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex');
  function run(label,args,{cwd=process.cwd(),env=process.env}={}) {
    const result=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',timeout:900000,maxBuffer:64*1024*1024});
    const text=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(`${output}/${label}.log`,text);
    assert(!result.error&&!result.signal,`${label}: ${result.error||result.signal}`);
    const counts={tests:0,pass:0,fail:0};for(const [,key,n] of text.matchAll(/^ℹ (tests|pass|fail) (\d+)$/gm)) counts[key]+=Number(n);
    const failures=[...new Set([...text.matchAll(/^✖ (.+?) \([\d.]+ms\)/gm)].map(match=>match[1]))];
    return {exit:result.status,...counts,failures,text};
  }
  function clone(destination) {
    fs.mkdirSync(destination,{recursive:true});fs.cpSync('src',`${destination}/src`,{recursive:true});
    fs.cpSync('test',`${destination}/test`,{recursive:true});fs.mkdirSync(`${destination}/tools`);
    fs.copyFileSync(import.meta.filename,`${destination}/tools/delivery-kit-checks.mjs`);
    for(const name of ['node_modules','public','migrations','contracts']) fs.symlinkSync(path.resolve(name),`${destination}/${name}`);
    fs.symlinkSync(path.resolve('netsuite-ifir-posting-restlet.js'),`${destination}/netsuite-ifir-posting-restlet.js`);
    fs.copyFileSync('package.json',`${destination}/package.json`);
  }
  const baseline=`${output}/baseline`;clone(baseline);
  for(const file of changed) {
    if(fs.existsSync(`/baseline-source/${file}`)) fs.copyFileSync(`/baseline-source/${file}`,`${baseline}/${file}`);
    else fs.rmSync(`${baseline}/${file}`);
  }
  const summarize=({text:_text,...result})=>result;
  const base=run('baseline',['tools/delivery-kit-checks.mjs','suite','baseline'],{cwd:baseline});
  report.baseline=summarize(base);console.log(JSON.stringify({stage:'baseline',...report.baseline}));
  for(const mode of ['candidate','reverse']) {
    const result=run(mode,['tools/delivery-kit-checks.mjs','suite',mode],{env:mode==='candidate'?{...process.env,NODE_V8_COVERAGE:`${output}/v8`}:process.env});
    report[mode]={...summarize(result),newFailures:result.failures.filter(name=>!base.failures.includes(name))};
    console.log(JSON.stringify({stage:mode,...report[mode]}));
    if(report[mode].newFailures.length) console.error(result.text.slice(-18000));
    assert.equal(report[mode].newFailures.length,0);assert.equal(result.fail,result.failures.length);assert(result.tests>base.tests);
  }
  const coverage=run('coverage-report',['node_modules/c8/bin/c8.js','report','--check-coverage=false',`--temp-directory=${output}/v8`,
    `--report-dir=${output}/coverage`,'--reporter=json',...changed.map(file=>`--include=${file}`)]);
  assert.equal(coverage.exit,0);
  const map=coverageLibrary.createCoverageMap(JSON.parse(fs.readFileSync(`${output}/coverage/coverage-final.json`)));
  const empty=`${output}/empty`;fs.writeFileSync(empty,'');
  report.coverage={covered:0,total:0,misses:[]};report.secrets=[];
  for(const file of changed) {
    const before=fs.existsSync(`/baseline-source/${file}`)?`/baseline-source/${file}`:empty;
    const diff=spawnSync('diff',['-U0',before,file],{encoding:'utf8'}).stdout;
    report.secrets.push(...scanUnifiedDiff(diff));
    const lines=map.fileCoverageFor(path.resolve(file)).getLineCoverage();
    for(const match of diff.matchAll(/^@@ .*? \+(\d+)(?:,(\d+))? @@/gm)) for(let offset=0;offset<Number(match[2]??1);offset++) {
      const line=Number(match[1])+offset;if(lines[line]===undefined)continue;
      report.coverage.total++;if(lines[line]>0)report.coverage.covered++;else report.coverage.misses.push(`${file}:${line}`);
    }
  }
  console.log(JSON.stringify({stage:'coverage',...report.coverage}));
  assert.equal(report.coverage.misses.length,0);assert.equal(report.secrets.length,0);
  const lint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'module'},
    rules:{eqeqeq:'error','no-unreachable':'error','no-unused-vars':['error',{argsIgnorePattern:'^_'}],'prefer-const':'error'}}]});
  const diagnostics=async root=>{
    const values=[];for(const file of changed) if(fs.existsSync(`${root}/${file}`)) {
      const [result]=await lint.lintText(fs.readFileSync(`${root}/${file}`,'utf8'),{filePath:file});
      values.push(...result.messages.map(m=>`${file}:${m.ruleId}:${m.message}`));
    }return values;
  };
  const difference=(old,next)=>next.filter(value=>!old.includes(value));
  report.lint={new:difference(await diagnostics(baseline),await diagnostics(process.cwd()))};
  const types=root=>run(root===baseline?'types-baseline':'types-candidate',['node_modules/typescript/bin/tsc','--noEmit','--allowJs','--checkJs','--skipLibCheck',
    '--module','nodenext','--target','es2022',...changed.filter(file=>fs.existsSync(`${root}/${file}`))],{cwd:root}).text.split('\n')
    .filter(line=>changed.some(file=>line.startsWith(file+'('))).map(line=>line.replace(/\(\d+,\d+\)/g,''));
  const oldTypes=types(baseline),newTypes=types(process.cwd());report.types={before:oldTypes.length,after:newTypes.length,new:difference(oldTypes,newTypes)};
  console.log(JSON.stringify({stage:'static',lint:report.lint,types:report.types}));
  assert.equal(report.lint.new.length,0);assert.equal(report.types.new.length,0);
  const mutant=`${output}/mutant`;clone(mutant);
  const mutants=[
    ['wrong-parent-item','src/sales-order-auto-fulfillment-kits.js','line.kit.definition.parent.itemId','99999'],
    ['missing-kit-evidence','src/sales-order-auto-fulfillment-kits.js','kitPostingLines:mapped','kitPostingLines:[]'],
    ['component-as-rest-line','src/sales-order-auto-fulfillment-kits.js','physical.push({...member,quantity:','physical.push({...member,orderLine:group.parent.orderLine,quantity:'],
    ['inflated-parent-quantity','src/sales-order-auto-fulfillment-kits.js','return {selectedLines:mapped,availableLines:','return {selectedLines:mapped.map(line=>({...line,quantity:line.quantity+1})),availableLines:']
  ];
  report.mutations=[];
  for(const [name,file,before,after] of mutants) {
    const original=fs.readFileSync(`${mutant}/${file}`,'utf8');assert.equal(original.split(before).length,2,name);
    try {
      fs.writeFileSync(`${mutant}/${file}`,original.replace(before,after));
      const result=run(`mutant-${name}`,['--test','--test-reporter=spec','--test-name-pattern=^property:',primary[0]],{cwd:mutant});
      report.mutations.push({name,propertyOnly:true,killed:result.exit===1&&result.failures.length===1});
    } finally {fs.writeFileSync(`${mutant}/${file}`,original);}
  }
  assert(report.mutations.every(value=>value.killed));
  for(const name of changed) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex'),report.hashes[name]);
  console.log(`DELIVERY_KIT_REPORT ${JSON.stringify(report)}`);
}
