// Operational verification and local search-cache refresh; no NetSuite writes.
// Company settings are established by the reviewed migration, never guessed here.
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {query,closeDb} from '../src/db.js';
import {repairNetSuiteRecord,suiteqlAll} from '../src/netsuite.js';
import {createRepairNetSuite} from '../src/repair/netsuite.js';
import {createRepairRepository} from '../src/repair/repository.js';
import {createRepairDirectory} from '../src/repair/directory.js';
const actor={id:'deployment:repair-portal-20261027',role:'repair_office'};
const repo=createRepairRepository();
const adapter=createRepairNetSuite({record:repairNetSuiteRecord,queryAll:suiteqlAll});
const directory=createRepairDirectory({repo,adapter,enabled:()=>config.repair.enabled});
try {
 assert.equal(config.repair.enabled,true);assert.equal(config.repair.postingEnabled,false);
 const settings=await repo.settings(actor);assert.equal(settings.postingEnabled,false);
 const mappings=settings.mappings;
 const customers=await suiteqlAll('SELECT id,companyname,isinactive FROM customer WHERE id IN (7973,13366,7143)');
 for(const [key,name] of Object.entries({mbtCustomerId:'Mr Bin Trucking Inc.',mbrCustomerId:'MBR - Rental Department',mbbsCustomerId:'Mr Bin Building Supply LTD.'})){
  const customer=customers.find(row=>String(row.id)===mappings[key]);assert.equal(customer?.companyname,name);assert.equal(customer.isinactive,'F');
 }
 const imported=await directory.sync(actor),[vehicles,machines]=await Promise.all([adapter.vehicles(),adapter.machines()]);
 const rows=(await query('SELECT id,netsuite_id,machine_id,company,active FROM repair_vehicles')).rows;
 assert.ok(vehicles.every(v=>rows.some(r=>String(r.netsuite_id)===String(v.id))));
 assert.ok(machines.every(m=>rows.some(r=>String(r.machine_id)===String(m.id))));
 const sample=machines.find(m=>m.alias&&m.isinactive!=='T');
 assert.ok((await directory.search(actor,sample.alias)).some(r=>r.machineId===String(sample.id)));
 const operatorRows=await directory.search({id:'deployment-check',role:'operator'});
 assert.ok(operatorRows.length>0);assert.ok(operatorRows.every(r=>r.company==='MBBS'));
 const driverRows=await directory.search({id:'deployment-check',role:'driver'});
 assert.ok(driverRows.length>0);assert.ok(driverRows.every(r=>r.company==='MBT'));
 const companies=(await query('SELECT company,count(*)::integer AS count FROM repair_vehicles WHERE active GROUP BY company ORDER BY company')).rows;
 const audit={imported,searchableEquipment:rows.filter(r=>r.active).length,companies,operatorEquipment:operatorRows.length,driverEquipment:driverRows.length,machineAliasSearchVerified:true,allSourceRecordsRepresented:true,financialPostingEnabled:false,netSuiteWrites:0};
 await query("INSERT INTO repair_events(actor,kind,data) VALUES($1,'deployment_directory_verified',$2)",['staff:'+actor.id,audit]);
 console.log(JSON.stringify(audit));
} finally {await closeDb();}
