import { createFieldSalesRepository } from '../src/field-sales/repository.js';
import { createCityImporter } from '../src/field-sales/importer.js';
import { closeDb } from '../src/db.js';
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('This verification tool requires an isolated database. Use the admin UI for operational imports.');}
const repo=createFieldSalesRepository(),importer=createCityImporter(repo);
try{for(const source of process.argv.slice(2)){console.log('Importing',source);console.log(await importer.run(source));}console.log((await repo.db.query(`SELECT source,count(*)::int AS addresses,count(DISTINCT jobsite_id)::int AS jobsites FROM field_sales_sources WHERE present GROUP BY source`)).rows);}finally{await closeDb();}
