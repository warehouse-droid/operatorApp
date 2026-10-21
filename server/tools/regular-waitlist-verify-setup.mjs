import assert from 'node:assert/strict';
import pg from 'pg';
const url=new URL(process.env.DATABASE_URL);
assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(url.hostname,'db');assert.equal(url.pathname,'/mbt_test');
url.pathname='/postgres';const client=new pg.Client({connectionString:url.href});await client.connect();
try{
  if(process.argv.includes('--reset'))await client.query('DROP DATABASE IF EXISTS mbt_verify WITH (FORCE)');
  if(!(await client.query("SELECT 1 FROM pg_database WHERE datname='mbt_verify'")).rowCount)await client.query('CREATE DATABASE mbt_verify TEMPLATE mbt_test');
  console.log('Dedicated waitlist verification database ready.');
}finally{await client.end();}
