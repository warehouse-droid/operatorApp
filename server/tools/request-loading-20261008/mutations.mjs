import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {query,closeDb} from '../../src/db.js';

const out='test-artifacts/request-mutations';fs.mkdirSync(out,{recursive:true});
const migration=fs.readFileSync('migrations/275_request_completion_lookup.sql','utf8');
const statement=migration.split('CREATE OR REPLACE VIEW ')[1].split(';\n')[0];
const original='CREATE OR REPLACE VIEW '+statement+';';
const results=[];
function run(name,args,cwd='/app'){
 const result=spawnSync(process.execPath,args,{cwd,encoding:'utf8',env:process.env});
 fs.writeFileSync(`${out}/${name}.log`,result.stdout+result.stderr);
 results.push({name,exit:result.status,killed:result.status===1 && /AssertionError|ERR_ASSERTION|Property failed after/.test(result.stdout+result.stderr)});
 assert.equal(results.at(-1).killed,true,`Surviving or invalid mutant: ${name}`);
}
const sqlMutants=[
 ['ignore-direct-reopen',"SELECT id, job_id FROM driver_job_corrections WHERE action = 'reopen'","SELECT id, job_id FROM driver_job_corrections WHERE action = 'reopen' AND false"],
 ['ignore-physical-visit',"WHERE correction.action = 'reopen'","WHERE correction.action = 'reopen' AND false"],
 ['discard-recaptured-cycle','correction.id > COALESCE','correction.id >= COALESCE']
];
try{
 for(const [name,from,to] of sqlMutants){
  assert.ok(original.includes(from));const mutant=original.replace(from,to);fs.writeFileSync(`${out}/${name}.sql`,mutant);
  try{await query(mutant);run(name,['--test','--test-name-pattern=effective completion','test/request-loading-database.test.js']);}
  finally{await query(original);}
 }
 const originalFunction='CREATE OR REPLACE FUNCTION '+migration.split('CREATE OR REPLACE FUNCTION ')[1].split('$$;')[0]+'$$;';
 const alias="UNION SELECT regexp_replace(name, '-S[0-9]+$', '') FROM names";
 assert.ok(originalFunction.includes(alias));
 const mutantFunction=originalFunction.replace(alias,"UNION SELECT '' FROM names");
 fs.writeFileSync(out+'/omit-split-parent.sql',mutantFunction);
 try {
  await query(mutantFunction);
  run('omit-split-parent',['--test','--test-name-pattern=planning reference filter','test/request-loading-database.test.js']);
 } finally {await query(originalFunction);}
 const priority='CREATE OR REPLACE FUNCTION dispatch_completion_evidence_priority'+migration.split('CREATE OR REPLACE FUNCTION dispatch_completion_evidence_priority')[1].split('$$;')[0]+'$$;';
 assert.ok(priority.includes("WHEN 'driver_job'::text THEN 10"));
 const wrongPriority=priority.replace("WHEN 'driver_job'::text THEN 10","WHEN 'driver_job'::text THEN 99");
 fs.writeFileSync(out+'/wrong-completion-priority.sql',wrongPriority);
 try {
  await query(wrongPriority);run('wrong-completion-priority',['--test','--test-name-pattern=effective completion','test/request-loading-database.test.js']);
 } finally {await query(priority);}
 const dir='/tmp/request-loading-mutants';fs.mkdirSync(dir+'/test',{recursive:true});fs.mkdirSync(dir+'/public',{recursive:true});
 fs.writeFileSync(dir+'/package.json','{"type":"module"}');
 if(!fs.existsSync(dir+'/node_modules')){fs.symlinkSync('/app/node_modules',dir+'/node_modules');}
 fs.copyFileSync('test/request-loading-ui.test.js',dir+'/test/request-loading-ui.test.js');
 for(const name of ['wrong-selected-record']){
  for(const role of ['sales','scm']){
   const source=fs.readFileSync(`public/${role}-stock-requests.js`,'utf8');
   const from=name==='wrong-selected-record'?'requests.find((request) => Number(request.id) === Number(selectedId))':'!["backorder", "waitlist"].includes(selected.regular?.deliveryMethod)';
   const to=name==='wrong-selected-record'?'requests[0]':'true';assert.ok(source.includes(from));
   const mutant=source.replace(from,to);fs.writeFileSync(`${dir}/public/${role}-stock-requests.js`,mutant);fs.writeFileSync(`${out}/${name}-${role}.js`,mutant);
  }
  run(name,['--test','--test-name-pattern=selection property','test/request-loading-ui.test.js'],dir);
 }
}finally{
 await query(original);await closeDb();
 fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));
}
