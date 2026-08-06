// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { P3_DEDICATED_MUTATION_RUNNERS } from "./p3-mutation-manifest.mjs";

const supportDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(supportDirectory, "../..");
const SELF = path.basename(fileURLToPath(import.meta.url));
const ADMIN_ENVIRONMENTS = Object.freeze([
  "MBT_P38_MUTATION_ADMIN_URL",
  "MBT_P39_MUTATION_ADMIN_URL",
  "MBT_P310_MUTATION_ADMIN_URL",
  "MBT_P311_MUTATION_ADMIN_URL"
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string[]} values */
function sortedUnique(values) {
  return [...new Set(values)].sort();
}

async function assertManifestOwnsEveryDedicatedRunner() {
  const onDisk = (await readdir(supportDirectory))
    .filter((name) => /^run-.+-mutations?\.mjs$/u.test(name))
    .filter((name) => name !== SELF)
    .sort();
  const declared = P3_DEDICATED_MUTATION_RUNNERS.map((entry) => entry.runner).sort();
  if (new Set(declared).size !== declared.length
      || JSON.stringify(onDisk) !== JSON.stringify(declared)) {
    throw new Error(
      `The Phase 3 dedicated mutation runner manifest is incomplete: `
      + `on-disk=${JSON.stringify(onDisk)} declared=${JSON.stringify(declared)}.`
    );
  }
}

/** @param {readonly string[]} relativePaths */
async function sourceHashes(relativePaths) {
  const hashes = new Map();
  for (const relativePath of sortedUnique([...relativePaths])) {
    const target = path.resolve(serverRoot, relativePath);
    if (target !== serverRoot && !target.startsWith(`${serverRoot}${path.sep}`)) {
      throw new Error(`The Phase 3 mutation source path escapes the server root: ${relativePath}.`);
    }
    hashes.set(relativePath, sha256(await readFile(target)));
  }
  return hashes;
}

/** @param {Map<string, string>} expected @param {string} runner */
async function assertSourceHashes(expected, runner) {
  for (const [relativePath, expectedHash] of expected) {
    const actualHash = sha256(await readFile(path.resolve(serverRoot, relativePath)));
    if (actualHash !== expectedHash) {
      throw new Error(
        `${runner}: source restoration hash mismatch for ${relativePath}; `
        + `expected ${expectedHash}, received ${actualHash}.`
      );
    }
  }
}

/** @param {string} runner @param {NodeJS.ProcessEnv} environment */
function runRunner(runner, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join("test/support", runner)], {
      cwd: serverRoot,
      env: environment,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${runner} exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Phase 3 extended mutations require the writable disposable mutation container.");
}
const adminUrlText = String(process.env.MBT_P3_MUTATION_ADMIN_URL || "").trim();
if (!adminUrlText) {
  throw new Error("MBT_P3_MUTATION_ADMIN_URL is required.");
}
const adminUrl = new URL(adminUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(adminUrl.protocol)) {
  throw new Error("MBT_P3_MUTATION_ADMIN_URL must use PostgreSQL.");
}
adminUrl.pathname = "/postgres";

await assertManifestOwnsEveryDedicatedRunner();

let completed = 0;
for (const entry of P3_DEDICATED_MUTATION_RUNNERS) {
  const before = await sourceHashes(entry.sourcePaths);
  const environment = { ...process.env };
  for (const name of ADMIN_ENVIRONMENTS) {delete environment[name];}
  if (entry.adminUrlEnvironment) {
    environment[entry.adminUrlEnvironment] = adminUrl.toString();
  }
  let exitCode;
  try {
    exitCode = await runRunner(entry.runner, environment);
  } finally {
    await assertSourceHashes(before, entry.runner);
  }
  if (exitCode !== 0) {
    throw new Error(`${entry.runner} failed with exit code ${exitCode}.`);
  }
  completed += 1;
  console.log(`[P3 mutation] ${completed}/${P3_DEDICATED_MUTATION_RUNNERS.length} ${entry.runner} passed and restored its sources.`);
}

console.log(
  `Phase 3 extended mutation runners: ${completed}/${P3_DEDICATED_MUTATION_RUNNERS.length} passed; `
  + "every declared source hash restored."
);
