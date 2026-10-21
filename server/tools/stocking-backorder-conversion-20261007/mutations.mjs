import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,openSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const out=resolve('test-artifacts/stocking-backorder-conversion-20261007');
const api='test/mbt/integration/stocking-backorder-conversion.test.js',properties='test/mbt/property/stocking-backorder-conversion.property.test.js',browser='test/mbt/integration/stocking-backorder-conversion-browser.test.js';
const list=[
  {name:'only-first-material',file:'src/stocking-backorder-conversion.js',before:'lines:materials}',after:'lines:materials.slice(0,1)}',pattern:'^SCM converts the entire'},
  {name:'recalculate-saved-quantity',file:'public/stocking-backorder-conversion.js',before:'quantity:Number(line.sales_qty)',after:'quantity:Number(line.sales_qty)*Number(item.to_pcs || 1)',pattern:'^conversion preserves saved',property:true},
  {name:'allow-rejected-material',file:'public/stocking-backorder-conversion.js',before:"'submitted','changes_requested','approved'",after:"'submitted','changes_requested','approved','rejected'",pattern:'^conversion rejects terminal',property:true},
  {name:'allow-empty-request',file:'public/stocking-backorder-conversion.js',before:'request.lines?.length>=1',after:'request.lines?.length>=0',property:true},
  {name:'ignore-revision',file:'src/stocking-backorder-conversion.js',before:'if (revision!==undefined && Number(request.revision)!==revision)',after:'if (false && revision!==undefined && Number(request.revision)!==revision)',pattern:'^invalid revision'},
  {name:'drop-commitment-check',file:'src/stocking-backorder-conversion.js',before:'if (commitment.rowCount)',after:'if (false && commitment.rowCount)',pattern:'^a concurrent Stocking commitment'},
  {name:'lose-requesting-sales-yard',file:'src/stocking-backorder-conversion.js',before:'request.regular_details.requestingLocationId ?? request.destination_location_id',after:'request.destination_location_id',pattern:'^only SCM can convert'},
  {name:'vendor-override-keeps-stale-ID',file:'public/stocking-backorder-conversion.js',before:'sameVendor && item.vendor_id!=null',after:'item.vendor_id!=null',pattern:'^Delivery conversion'},
  {name:'lose-audit-history',file:'src/special-stock-request-repository.js',before:'eventsResult.rows.push(...prior.rows);',after:'eventsResult.rows.push();',pattern:'^SCM converts the entire'},
  {name:'remove-SCM-route-authorization',file:'src/backorder-request-routes.js',before:"app.post('/api/scm/stock-requests/:id/backorder-conversion',scmWrite,",after:"app.post('/api/scm/stock-requests/:id/backorder-conversion',",pattern:'^only SCM can convert'},
  {name:'reuse-Stocking-notification-IDs',file:'src/stocking-backorder-conversion.js',before:"await query('DELETE FROM regular_stock_decision_reads WHERE request_id=$1',[selected]);",after:'await Promise.resolve();',pattern:'^previous Stocking notification'},
  {name:'lose-existing-receiving-yard',file:'src/backorder-request-service.js',before:'const routingYards=keepingDestination?',after:'const routingYards=false && keepingDestination?',pattern:'^Sales can revise a converted material'},
  {name:'allow-material-demand',file:'public/stocking-backorder-conversion.js',before:' && !line.purchase?.demandId',after:'',property:true},
  {name:'duplicate-pending-submit',file:'public/stocking-backorder-conversion-ui.js',before:'if(submitting)return;',after:'if(false && submitting)return;',pattern:'^a pending conversion',browser:true},
  {name:'hide-preview-error',file:'public/stocking-backorder-conversion-ui.js',before:"catch(caught){if(dialog.isConnected)(/** @type {HTMLElement} */ (dialog.querySelector('[data-stocking-backorder-error]'))).textContent=(/** @type {Error} */ (caught)).message;}",after:'catch(caught){void caught;}',pattern:'^a failed or cancelled preview',browser:true}
];
const hash=source=>createHash('sha256').update(source).digest('hex');
const root=mkdtempSync('/tmp/mbbs-stocking-conversion-mutants-'),results=[];
function run(label,args,{allowFailure=false}={}) {
  const fd=openSync(out+'/'+label+'.log','w');let result;
  try{result=spawnSync(process.execPath,args,{cwd:root,stdio:['ignore',fd,fd],timeout:180000});}finally{closeSync(fd);}
  const log=readFileSync(out+'/'+label+'.log','utf8');assert.notEqual(result.status,null,'Mutation timeout');
  if(!allowFailure)assert.equal(result.status,0,log.slice(-2500));return {exit:result.status,log};
}
function reset(label) {
  run(label+'-reset',['--input-type=module','-e',`import pg from 'pg';const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='db'||u.pathname!=='/mbt_test')throw Error('Not isolated');u.pathname='/postgres';const c=new pg.Client({connectionString:u.href});try{await c.connect();await c.query('DROP DATABASE mbt_test WITH (FORCE)');await c.query('CREATE DATABASE mbt_test');}finally{await c.end();}`]);
  run(label+'-migrate',['src/migrate.js']);
}
try {
  for(const dir of ['src','public','test'])cpSync(dir,root+'/'+dir,{recursive:true});
  for(const dir of ['node_modules','migrations','tools','contracts'])symlinkSync(resolve(dir),root+'/'+dir);
  cpSync('package.json',root+'/package.json');mkdirSync(root+'/test-artifacts');
  for(const mutant of list) {
    const source=readFileSync(mutant.file,'utf8');assert.equal(source.split(mutant.before).length,2,'Unique mutation anchor '+mutant.name);
    try {
      writeFileSync(root+'/'+mutant.file,source.replace(mutant.before,mutant.after));
      if(mutant.pattern)reset(mutant.name);
      const r=run('mutation-'+mutant.name,['--test',...(mutant.pattern?['--test-name-pattern='+mutant.pattern,mutant.browser?browser:api]:[properties])],{allowFailure:true});
      assert.equal(r.exit,1,mutant.name+' survived');assert.match(r.log,/^not ok /m);assert.ok(!r.log.includes("failureType: 'hookFailed'"),mutant.name+' setup failure');
      let propertyKilled=false;
      if(mutant.property){const p=run('property-mutation-'+mutant.name,['--test',properties],{allowFailure:true});assert.equal(p.exit,1);assert.match(p.log,/^not ok /m);propertyKilled=true;}
      results.push({name:mutant.name,killed:true,propertyKilled,failures:[...r.log.matchAll(/^not ok \d+ - (.*)$/gm)].map(value=>value[1])});
    }finally{writeFileSync(root+'/'+mutant.file,source);assert.equal(hash(readFileSync(root+'/'+mutant.file)),hash(readFileSync(mutant.file)));}
  }
}finally{rmSync(root,{recursive:true,force:true});}
writeFileSync(out+'/mutations.json',JSON.stringify(results,null,2));console.log(JSON.stringify({killed:results.length,propertyKilled:results.filter(row=>row.propertyKilled).length}));
