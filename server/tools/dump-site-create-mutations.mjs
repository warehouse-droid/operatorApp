import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const unit='test/mbt/unit/dump-site-code.test.js',browser='test/mbt/integration/dump-site-create-browser.test.js';
const service='src/mbt/local-master-data-service.js';
const mutations=[
  {name:'dump-reject-numeric',file:service,from:'return normalizedCode(value, /^[A-Z0-9][A-Z0-9_-]{0,63}$/u,',to:'return normalizedCode(value, /^[A-Z][A-Z0-9_-]{0,63}$/u,',test:unit,expected:'code property:'},
  {name:'dump-reject-hyphens',file:service,from:'return normalizedCode(value, /^[A-Z0-9][A-Z0-9_-]{0,63}$/u,',to:'return normalizedCode(value, /^[A-Z0-9][A-Z0-9_]{0,63}$/u,',test:unit,expected:'code property:'},
  {name:'dump-state-identity-mismatch',file:service,from:'? normalizedDumpSiteCode(input.entityId)',to:'? masterIdentity(input.entityId, "Dump-site code")',matches:2,test:browser,expected:'browser: create dump site 3445'},
  {name:'dump-skip-browser-hours',file:'public/mbt-shell.js',from:'if (invalidHours) {',to:'if (false) {',test:browser,expected:'browser: create dump site 3445'}
];
const results=[];
for(const mutation of mutations) {
  const root=mkdtempSync('test-artifacts/dump-site-mutant-');
  try {
    for(const dir of ['src','public','contracts','test/support','test/mbt/support']) cpSync(dir,`${root}/${dir}`,{recursive:true});
    for(const file of [unit,browser]) {mkdirSync(dirname(`${root}/${file}`),{recursive:true});cpSync(file,`${root}/${file}`);}
    cpSync('package.json',`${root}/package.json`);symlinkSync('/app/node_modules',`${root}/node_modules`);
    const target=`${root}/${mutation.file}`,source=readFileSync(target,'utf8');
    if(source.split(mutation.from).length!==(mutation.matches||1)+1) throw new Error(`Mutation source mismatch: ${mutation.name}`);
    writeFileSync(target,source.replace(mutation.from,mutation.to));
    const run=spawnSync(process.execPath,['tools/bin-planning-suites.mjs','selected',resolve(root,mutation.test)],
      {encoding:'utf8',maxBuffer:16*1024*1024,timeout:90000,env:process.env});
    const output=run.stdout+run.stderr;writeFileSync(`test-artifacts/${mutation.name}.log`,output);
    const killed=run.status!==0 && output.split('\n').some(line=>line.includes('✖')&&line.includes(mutation.expected)) && /AssertionError|Property failed|expect\(locator\)/u.test(output);
    results.push({name:mutation.name,killed,exitCode:run.status});console.log(JSON.stringify(results.at(-1)));
    if(!killed) console.log(output.slice(-5000));
  } finally {rmSync(root,{recursive:true,force:true});}
}
writeFileSync('test-artifacts/bin-selection-mutations.json',JSON.stringify(results,null,2));
if(results.some(r=>!r.killed)) process.exitCode=1;
