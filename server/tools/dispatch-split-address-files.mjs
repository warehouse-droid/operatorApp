import path from "node:path";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

process.exitCode = await runNodeTestFilesIsolated(process.argv.slice(2).map(file => path.resolve(file)), {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }),
  label: "Split address selected tests"
});
