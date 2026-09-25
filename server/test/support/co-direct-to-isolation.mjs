import pg from "pg";
import { describeIsolatedTestDatabase, isolatedTestDatabaseName, isolatedTestDatabaseUrl } from "./test-database-isolation.mjs";

export async function withCoTestDatabase(name, run) {
  const databaseUrl = process.env.DATABASE_URL;
  const boundary = describeIsolatedTestDatabase(databaseUrl);
  const database = isolatedTestDatabaseName(`co-direct-to:${process.pid}:${name}`, 0);
  const admin = new pg.Client({ connectionString: boundary.adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${boundary.baseDatabaseName}"`);
    try {return run(isolatedTestDatabaseUrl(databaseUrl, database));}
    finally {await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);}
  } finally {await admin.end();}
}
