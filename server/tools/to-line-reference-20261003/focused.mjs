import pg from 'pg';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {describeIsolatedTestDatabase,isolatedTestDatabaseName,isolatedTestDatabaseUrl} from '../../test/support/test-database-isolation.mjs';
const base=process.env.DATABASE_URL;
const boundary=describeIsolatedTestDatabase(base),name=isolatedTestDatabaseName(crypto.randomUUID(),0);
const admin=new pg.Client({connectionString:boundary.adminUrl});
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "mbt_test"`);
  const [command,...args]=process.argv.slice(2);
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',env:{...process.env,DATABASE_URL:isolatedTestDatabaseUrl(base,name)}});
    child.once('error',reject);child.once('exit',code=>resolve(code));
  });
  process.exitCode=code || 0;
}finally{await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
