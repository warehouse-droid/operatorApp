import {spawn} from 'node:child_process';
import pg from 'pg';
import {describeIsolatedTestDatabase,isolatedTestDatabaseName,isolatedTestDatabaseUrl} from '../../test/support/test-database-isolation.mjs';
const boundary=describeIsolatedTestDatabase(process.env.DATABASE_URL,process.env);
const name=isolatedTestDatabaseName('request-loading-'+process.pid+'-'+Date.now(),0);
const client=new pg.Client({connectionString:boundary.adminUrl});await client.connect();
try{
 await client.query(`CREATE DATABASE "${name}" TEMPLATE "${boundary.baseDatabaseName}"`);
 const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit',env:{...process.env,DATABASE_URL:isolatedTestDatabaseUrl(process.env.DATABASE_URL,name)}});
 const forward=signal=>child.kill(signal);process.once('SIGINT',forward);process.once('SIGTERM',forward);
 process.exitCode=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve(signal?1:code??1)));
 process.removeListener('SIGINT',forward);process.removeListener('SIGTERM',forward);
}finally{
 await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await client.end();
}
