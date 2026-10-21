import {cp,mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const scratch=await mkdtemp('/tmp/delivery-ui-mutants-');
const results=[];
try {
  await cp('public',path.join(scratch,'public'),{recursive:true,filter:source=>source==='public' || /\.(js|css|html)$/.test(source)});
  await mkdir(path.join(scratch,'test/mbt/integration'),{recursive:true});
  await mkdir(path.join(scratch,'test/mbt/support'),{recursive:true});
  for(const file of ['delivery-requests-browser.test.js','delivery-request-event-stream-browser.test.js']) {
    await cp(`test/mbt/integration/${file}`,path.join(scratch,'test/mbt/integration',file));
  }
  await cp('test/mbt/support/delivery-request-fixtures.js',path.join(scratch,'test/mbt/support/delivery-request-fixtures.js'));
  await writeFile(path.join(scratch,'package.json'),'{"type":"module"}\n');
  await symlink(path.resolve('node_modules'),path.join(scratch,'node_modules'));
  await symlink(path.resolve('test-artifacts'),path.join(scratch,'test-artifacts'));
  const mutants=[
    {name:'constant origin instead of selected outbound',file:'delivery-requests.js',from:'pricingOriginYardCode:outbounds[0].originYardCode',to:"pricingOriginYardCode:'3445'",pattern:'UI: each outbound yard'},
    {name:'drop all but first selected status',file:'delivery-requests.js',from:"statuses.forEach(status=>query.append('status',status));",to:"statuses.slice(0,1).forEach(status=>query.append('status',status));",pattern:'UI: multiple status checkboxes'},
    {name:'hide document overflow',file:'delivery-requests.css',from:'body.delivery-request-page { overflow-y:auto; }',to:'body.delivery-request-page { overflow-y:hidden; }',pattern:'UI: document scroll'},
    {name:'replace delivery address with customer',file:'delivery-requests.js',from:"leg.legType==='transfer'?leg.destinationYardCode:deliveryAddress",to:"leg.legType==='transfer'?leg.destinationYardCode:'customer'",pattern:'UI: draft and saved trip'},
    {name:'suppress newer revisions for open request',file:'delivery-request-alert.js',from:'item.id!==displayed?.currentRequestId || item.revision>(displayed.currentRequestRevision || 0)',to:'item.id!==displayed?.currentRequestId',pattern:'UI: proposed times and preapprovals'}
  ];
  for(const mutant of mutants) {
    const target=path.join(scratch,'public',mutant.file),original=await readFile(target,'utf8');
    assert.equal(original.split(mutant.from).length,2,`Unique mutation point: ${mutant.name}`);
    try {
      await writeFile(target,original.replace(mutant.from,mutant.to));
      const run=spawnSync(process.execPath,['--test','--test-concurrency=1',`--test-name-pattern=${mutant.pattern}`,
        'test/mbt/integration/delivery-requests-browser.test.js','test/mbt/integration/delivery-request-event-stream-browser.test.js'],
      {cwd:scratch,encoding:'utf8',timeout:60000,env:{...process.env,DELIVERY_UI_COVERAGE:'0'}});
      await writeFile(`test-artifacts/delivery-requests-ui/mutant-${results.length+1}.log`,run.stdout+run.stderr);
      const killed=run.status!==0 && /not ok \d+ - UI:/.test(run.stdout);
      results.push({name:mutant.name,killed,status:run.status});
      process.stdout.write(JSON.stringify(results.at(-1))+'\n');
      assert.ok(killed,`Mutant must fail a behavioral assertion: ${mutant.name}`);
      if(mutant.file==='delivery-requests.js' && mutant.pattern==='UI: each outbound yard') {
        const property=spawnSync(process.execPath,['--test','--test-name-pattern=UI: randomized',
          'test/mbt/integration/delivery-requests-browser.test.js'],
        {cwd:scratch,encoding:'utf8',timeout:60000,env:{...process.env,DELIVERY_UI_COVERAGE:'0'}});
        await writeFile('test-artifacts/delivery-requests-ui/property-mutant.log',property.stdout+property.stderr);
        results.at(-1).propertyKilled=property.status!==0 && /not ok \d+ - UI: randomized/.test(property.stdout);
        assert.ok(results.at(-1).propertyKilled,'The yard-origin property must independently reject the constant-origin mutant');
      }
    } finally {await writeFile(target,original);}
  }
  await writeFile('test-artifacts/delivery-requests-ui/mutations.json',JSON.stringify(results,null,2)+'\n');
} finally {await rm(scratch,{recursive:true,force:true});}
