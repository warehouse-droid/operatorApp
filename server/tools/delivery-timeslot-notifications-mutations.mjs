import {cp,mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const scratch=await mkdtemp('/tmp/delivery-notification-mutants-'),results=[];
const domain='src/delivery-request-domain.js',os='public/app-notifications.js';
const unit='test/mbt/unit/delivery-timeslot-counter.test.js',trips='test/mbt/unit/delivery-request-trips.test.js',browser='test/mbt/integration/app-notifications-browser.test.js';
const mutants=[
  {name:'counter changes the secured schedule prematurely',file:domain,
    from:"return {...row,pendingWindow:normalizeDeliveryWindow(input.window),pendingWindowProposedBy:'dispatch'};",
    to:"return {...row,confirmedWindow:normalizeDeliveryWindow(input.window),pendingWindow:normalizeDeliveryWindow(input.window),pendingWindowProposedBy:'dispatch'};",test:unit,property:'generated negotiation'},
  {name:'the proposing team can accept its own window',file:domain,from:'if(proposer===audience)',to:'if(proposer!==audience)',test:unit,property:'generated negotiation'},
  {name:'round-trip return is multiplied by outbound quantity',file:domain,from:'originYardCode:origin,totalUnits:capacity',to:'originYardCode:origin,totalUnits:pricing.totalUnits',test:trips},
  {name:'last drop-off is allowed outside an MBBS yard',file:domain,from:"tripEndpoint(leg,'dropoff',index===last)",to:"tripEndpoint(leg,'dropoff',false)",test:trips},
  {name:'multi-stop quotes omit every leg after the first',file:domain,
    from:'totalAmountMinor:safeMoney(outbounds.reduce((sum,leg)=>sum+leg.totalAmountMinor,0))',to:'totalAmountMinor:outbounds[0].totalAmountMinor',test:trips,property:'generated per-leg'},
  {name:'background delivery alerts are skipped',file:'public/delivery-request-alert.js',
    from:"if(token()!==session) {return checkSession();}\n    if(!actor) {return;}",
    to:"if(token()!==session) {return checkSession();}\n    if(!actor || document.hidden) {return;}",test:browser,pattern:'secured Sales time changes'},
  {name:'OS notifications repeat across refreshes and reloads',file:os,
    from:'seen.has(key) || receipts()[key]',to:'false',test:browser,pattern:'OS alerts deduplicate'},
  {name:'foreign OS notification links are accepted',file:os,
    from:'url.origin===location.origin',to:'true',test:browser,pattern:'notification links stay'}
];
function run(mutant,pattern) {
  const args=['--test','--test-concurrency=1'];if(pattern) {args.push(`--test-name-pattern=${pattern}`);}args.push(mutant.test);
  const result=spawnSync(process.execPath,args,{cwd:scratch,encoding:'utf8',timeout:45000,maxBuffer:8*1024*1024,
    env:{...process.env,DELIVERY_UI_COVERAGE:'0',XDG_CONFIG_HOME:'/tmp/mbbs-test-config',XDG_CACHE_HOME:'/tmp/mbbs-test-cache'}});
  return {result,killed:result.status!==0 && /not ok \d+ - /.test(result.stdout)};
}
try {
  for(const directory of ['src','public']) {await cp(directory,path.join(scratch,directory),{recursive:true});}
  for(const file of [unit,trips,browser,'test/mbt/support/delivery-request-fixtures.js']) {
    await mkdir(path.dirname(path.join(scratch,file)),{recursive:true});await cp(file,path.join(scratch,file));
  }
  await writeFile(path.join(scratch,'package.json'),'{"type":"module"}\n');
  await symlink(path.resolve('node_modules'),path.join(scratch,'node_modules'));
  for(const mutant of mutants) {
    const target=path.join(scratch,mutant.file),original=await readFile(target,'utf8');
    assert.equal(original.split(mutant.from).length,2,`Unique mutation point: ${mutant.name}`);
    const record={name:mutant.name,killed:false,restored:false};
    try {
      await writeFile(target,original.replace(mutant.from,mutant.to));
      const {result,killed}=run(mutant,mutant.pattern);record.killed=killed;record.exitCode=result.status;
      await writeFile(`test-artifacts/mutant-${results.length+1}.log`,result.stdout+result.stderr);
      if(mutant.property) {
        const property=run(mutant,mutant.property);record.propertyKilled=property.killed;
        await writeFile(`test-artifacts/property-mutant-${results.length+1}.log`,property.result.stdout+property.result.stderr);
        assert.ok(property.killed,`The property must independently reject ${mutant.name}`);
      }
    } finally {await writeFile(target,original);record.restored=(await readFile(target,'utf8'))===original;results.push(record);}
    process.stdout.write(JSON.stringify(record)+'\n');assert.ok(record.killed,`Behavioral assertions must reject ${mutant.name}`);
  }
} finally {
  await writeFile('test-artifacts/mutations.json',JSON.stringify(results,null,2)+'\n');await rm(scratch,{recursive:true,force:true});
}
