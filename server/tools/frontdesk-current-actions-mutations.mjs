import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const rates='src/mbt/frontdesk-action-rates.js',dump='src/mbt/bin-dump-charge.js';
const originals=Object.fromEntries([rates,dump].map(file=>[file,readFileSync(file,'utf8')]));
const mutations=[
  ['historical-rate',rates,'return String(active.rows[0].rate_card_version_id);','return requestedVersionId || String(active.rows[0].rate_card_version_id);'],
  ['foreign-card',rates,'if (requestedVersionId && card.requested_card_id !== card.rate_card_id)','if (false)'],
  ['reprice-exchange',dump,'if (saved.rows[0]?.pricing)','if (false)'],
  ['reprice-collection',dump,'const pinned = evidence.collection_pricing?.garbageDump;','const pinned = null;']
];
const suites=['integration/frontdesk-current-actions.test.js','integration/frontdesk-collection-rate.test.js','property/frontdesk-current-actions.property.test.js'];
const root=resolve(mkdtempSync('test-artifacts/current-action-mutants-')),results=[];
try {
  for(const folder of ['src','test/mbt/support']) cpSync(folder,`${root}/${folder}`,{recursive:true});
  cpSync('package.json',`${root}/package.json`);symlinkSync('/app/node_modules',`${root}/node_modules`);symlinkSync('/app/public',`${root}/public`);
  for(const suite of suites) {
    const file=`test/mbt/${suite}`;mkdirSync(`${root}/test/mbt/${suite.split('/')[0]}`,{recursive:true});cpSync(file,`${root}/${file}`);
  }
  for(const propertyOnly of [false,true]) for(const [name,target,from,to] of mutations) {
    for(const [file,source] of Object.entries(originals)) writeFileSync(`${root}/${file}`,source);
    if(originals[target].split(from).length!==2) throw new Error(`Mutation anchor mismatch: ${name}`);
    writeFileSync(`${root}/${target}`,originals[target].replace(from,to));
    const files=suites.filter(file=>!propertyOnly || file.startsWith('property/')).map(file=>`test/mbt/${file}`);
    const code=`import {runNodeTestFilesIsolated} from '/app/test/support/test-database-isolation.mjs'; process.exitCode=await runNodeTestFilesIsolated(${JSON.stringify(files)},{label:'current-action-mutant'});`;
    const run=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
    const output=run.stdout+run.stderr,killed=run.status!==0 && /AssertionError|Property failed/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output);
    results.push({name,propertyOnly,killed});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-4000));
  }
} finally {rmSync(root,{recursive:true,force:true});}
for(const [file,source] of Object.entries(originals)) if(readFileSync(file,'utf8')!==source) throw new Error('Mutation modified release source');
writeFileSync('test-artifacts/frontdesk-current-actions-mutations.json',JSON.stringify(results));
if(results.some(result=>!result.killed)) process.exitCode=1;
