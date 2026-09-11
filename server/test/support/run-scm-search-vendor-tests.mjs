import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";
import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const files = process.argv.slice(2);
if (!files.length) { throw new Error("Choose test files to run in disposable database clones."); }
process.exitCode = await runNodeTestFilesIsolated(files, {
  environment: buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL }),
  label: "SCM search and Vendor completion"
});
