import assert from 'node:assert/strict';
import v8ToIstanbul from 'v8-to-istanbul';
import istanbulCoverage from 'istanbul-lib-coverage';
const {createCoverageMap}=istanbulCoverage;
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,rmSync,mkdtempSync,cpSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const out='test-artifacts/conversation-followup-20261016';
const files=JSON.parse(readFileSync('tools/conversation-followup-20261016/files.json','utf8'));
const runtime=files.filter(file=>file.endsWith('.js'));
const unit=['stock-request-conversation','stock-request-conversation-order','special-stock-updates','stocking-replies','backorder-workflow','regular-stock-delivery-simple','regular-stock-delivery-selection'].map(name=>`test/mbt/unit/${name}.test.js`);
const integration=['stock-request-conversation','backorder-requests','stocking-replies-http','regular-stock-delivery-conversions','stock-request-conversation-browser'].map(name=>`test/mbt/integration/${name}.test.js`);
const tests=[...unit,...integration];
mkdirSync(out,{recursive:true});
function run(name,command,args,{failure=false,cwd=process.cwd(),env=process.env}={}) {
 const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024});
 const log=(result.stdout||'')+(result.stderr||'');writeFileSync(`${out}/${name}.log`,log);
 if(failure)assert.ok(result.status!==0 && /^not ok /m.test(log),`${name} survived`);
 else assert.equal(result.status,0,`${name} failed: ${log.slice(-6000)}`);
 console.log(JSON.stringify({check:name,passed:true}));return log;
}
run('types','node_modules/.bin/tsc',['--noEmit','--allowJs','--checkJs','--skipLibCheck','--types','node','--target','ES2022','--module','NodeNext','src/stock-request-conversation-domain.js']);
const own=['src/stock-request-conversation-queue.js','src/stock-request-conversation.js','src/stock-request-conversation-domain.js','src/stock-request-conversation-router.js','public/stock-request-conversation.js','public/stock-request-conversation-alert.js'];
run('lint','node_modules/.bin/eslint',['--config','tools/special-workflow-native-eslint.config.mjs','--max-warnings=0',...own,...tests.filter(file=>file.includes('conversation')), 'tools/conversation-followup-20261016/check.mjs']);
for(const file of runtime)run('syntax-'+file.split('/').pop(),process.execPath,['--check',file]);
rmSync(`${out}/c8`,{recursive:true,force:true});
const suite=run('suite','node_modules/.bin/c8',['--all=false','--check-coverage=false',...runtime.map(file=>`--include=${file}`),`--temp-directory=${out}/c8`,`--report-dir=${out}/coverage`,'--reporter=json','--reporter=json-summary',process.execPath,'--test','--test-concurrency=1',...tests]);
run('special-database',process.execPath,['--input-type=module','-e',"import {query,closeDb} from './src/db.js';try{await query('CREATE DATABASE mbt_verify TEMPLATE mbt_test');}finally{await closeDb();}"]);
let specialSuite;
try {specialSuite=run('special-information-suite',process.execPath,['--test','test/mbt/integration/special-stock-updates.test.js'],{failure:true,env:{...process.env,DATABASE_URL:(()=>{const url=new URL(process.env.DATABASE_URL);url.pathname='/mbt_verify';return url.href;})()}});}
finally {run('special-database-cleanup',process.execPath,['--input-type=module','-e',"import {query,closeDb} from './src/db.js';try{await query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');}finally{await closeDb();}"]);}
assert.match(specialSuite,/# pass 2\n# fail 1/);assert.match(specialSuite,/not ok 3 - Accepted Low inventory/);assert.match(specialSuite,/actual: 'confirmed'/);assert.match(specialSuite,/expected: 'dispatch_arrangement'/);
assert.match(readFileSync(`${out}/baseline-special-information.log`,'utf8'),/actual: 'confirmed'/);
const mutations=[
 {name:'scm-yard-restriction',file:'src/stock-request-conversation.js',from:"context.audience === 'sales' ? {authorizedStoreLocationIds:",to:"true ? {authorizedStoreLocationIds:",test:integration[0],pattern:'SCM HTTP access'},
 {name:'empty-placeholder',file:'public/stock-request-conversation.js',from:"'No messages yet.'",to:"'Loading conversation…'",test:integration.at(-1),pattern:'empty conversation'},
 {name:'old-message-first',file:'public/stock-request-conversation.js',from:'(activity.get(Number(b.id)) || 0) - (activity.get(Number(a.id)) || 0)',to:'(activity.get(Number(a.id)) || 0) - (activity.get(Number(b.id)) || 0)',test:unit[1],pattern:'property:'},
 {name:'drop-arrival-during-fetch',file:'public/stock-request-conversation.js',from:'view.pending = true;',to:'view.pending = false;',test:integration.at(-1),pattern:'conversation queue recovers'},
 {name:'sql-page-before-message-order',file:'src/stock-request-repository.js',from:'ORDER BY conversation_event_id DESC, EXISTS (',to:'ORDER BY EXISTS (',test:integration[0],pattern:'stocking queue sorts'}
];
const temp=mkdtempSync('/tmp/conversation-followup-mutants-');
try {
 for(const folder of ['src','public','test'])cpSync(folder,`${temp}/${folder}`,{recursive:true});
 cpSync('package.json',`${temp}/package.json`);symlinkSync(resolve('node_modules'),`${temp}/node_modules`,'dir');
 for(const mutant of mutations){
  const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.from).length,2);
  writeFileSync(`${temp}/${mutant.file}`,source.replace(mutant.from,mutant.to));
  try {run('mutant-'+mutant.name,process.execPath,['--test','--test-name-pattern='+mutant.pattern,mutant.test],{failure:true,cwd:temp,env:{...process.env,CONVERSATION_TEST_ARTIFACTS:resolve(out,'mutant-browser')}});}
  finally {writeFileSync(`${temp}/${mutant.file}`,source);}
 }
}finally{rmSync(temp,{recursive:true,force:true});}
const shuffled=[...unit].reverse();run('suite-health',process.execPath,['--test','--test-concurrency=1',...shuffled]);
run('secrets',process.execPath,['test/support/scan-diff-secrets.mjs',...runtime,...tests.filter(file=>file.includes('conversation'))]);
const coverage=createCoverageMap(JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`,'utf8')));
for(const entry of JSON.parse(readFileSync(`${out}/browser-coverage.json`,'utf8'))) {
 const file='public'+new URL(entry.url).pathname;
 if(!runtime.includes(file))continue;
 const converter=v8ToIstanbul(resolve(file),0,{source:entry.source});await converter.load();converter.applyCoverage(entry.functions);coverage.merge(converter.toIstanbul());
}
writeFileSync(`${out}/combined-coverage.json`,JSON.stringify(coverage.toJSON()));
const changed=JSON.parse(readFileSync(`${out}/changed-lines.json`,'utf8')),changedCoverage={};
for(const [file,lines]of Object.entries(changed)) {
 const measured=coverage.fileCoverageFor(resolve(file)).getLineCoverage();const executable=lines.filter(line=>Object.hasOwn(measured,line));
 const missed=executable.filter(line=>!measured[line]);changedCoverage[file]={covered:executable.length-missed.length,total:executable.length,missed};
}
writeFileSync(`${out}/changed-coverage.json`,JSON.stringify(changedCoverage,null,2));
const hashes=Object.fromEntries([...files,...tests,'tools/conversation-followup-20261016/check.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync(`${out}/source-manifest.json`,JSON.stringify(hashes,null,2));
const allSuites=suite+'\n'+specialSuite;
const total=label=>[...allSuites.matchAll(new RegExp('^# '+label+' (\\d+)','gm'))].reduce((sum,match)=>sum+Number(match[1]),0);
const summary={tests:total('tests'),passed:total('pass'),failures:total('fail'),knownBaselineFailures:1,newFailures:total('fail')-1,mutantsKilled:mutations.length};

writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
