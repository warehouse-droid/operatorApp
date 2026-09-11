import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildIsolatedTestEnvironment } from "./test-foundation.mjs";
import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const [mode, ...inputs] = process.argv.slice(2);
assert.ok(mode === "ordered" || mode === "shuffle");
const files = inputs.map((file) => path.resolve(file));
if (mode === "shuffle") {
  const key = (file) => createHash("sha256").update(`74537455:${file}`).digest("hex");
  files.sort((left, right) => key(left).localeCompare(key(right)));
}
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: String(process.env.DATABASE_URL || "") });
process.exitCode = await runNodeTestFilesIsolated(files, { environment, label: `CO cargo ${mode} seed=74537455` });
