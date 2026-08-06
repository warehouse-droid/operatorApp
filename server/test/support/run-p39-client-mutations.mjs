// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONTRACT_TEST = "test/mbt/unit/driver-bin-pwa-contract.test.js";
const MUTANTS = Object.freeze([
  {
    name: "an unversioned payload is accepted as a BIN work order",
    path: "public/driver-bin-ui.js",
    from: "return record(job).mbt?.schemaVersion === JOB_SCHEMA;",
    to: "return record(job).mbt?.schemaVersion !== JOB_SCHEMA;"
  },
  {
    name: "an older Driver client satisfies the work-order minimum version",
    path: "public/driver-bin-ui.js",
    from: "if (left < right) return false;",
    to: "if (left < right) return true;"
  },
  {
    name: "exact BIN asset matching is inverted",
    path: "public/driver-bin-ui.js",
    from: "return expected.includes(normalizedIdentity(scannedValue));",
    to: "return !expected.includes(normalizedIdentity(scannedValue));"
  },
  {
    name: "a balanced dump receipt is rejected while an unbalanced one is accepted",
    path: "public/driver-bin-ui.js",
    from: "if (subtotalMinor + taxMinor !== totalMinor) {",
    to: "if (subtotalMinor + taxMinor === totalMinor) {"
  },
  {
    name: "unknown draft fields survive manifest normalization",
    path: "public/driver-bin-ui.js",
    from: "const normalized = createDraft(job);",
    to: "const normalized = { ...source, ...createDraft(job) };"
  },
  {
    name: "an online BIN start stops attempting immediate ledger synchronization",
    path: "public/driver.js",
    from: "deferSync: false",
    to: "deferSync: true"
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("P3.9 client mutation tests require the writable disposable MBT test container.");
}

const originals = new Map();
for (const mutant of MUTANTS) {
  const target = path.resolve(mutant.path);
  if (!originals.has(target)) {
    originals.set(target, await readFile(target, "utf8"));
  }
}
const hashes = new Map([...originals].map(([target, source]) => [target, sha256(source)]));
let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const target = path.resolve(mutant.path);
    const original = originals.get(target);
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target in ${mutant.path}.`);
    }
    try {
      await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
      if (await run(process.execPath, ["--test", "--test-reporter=spec", CONTRACT_TEST]) === 0) {
        throw new Error(`${mutant.name}: survived the P3.9 Driver client contract suite.`);
      }
      killed += 1;
      console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    } finally {
      await writeFile(target, original, "utf8");
    }
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(target, original, "utf8");
  }
}

for (const [target, expectedHash] of hashes) {
  if (sha256(await readFile(target)) !== expectedHash) {
    throw new Error(`P3.9 client mutation testing did not restore ${path.relative(process.cwd(), target)} exactly.`);
  }
}
if (killed !== MUTANTS.length) {
  throw new Error(`P3.9 client mutation score ${killed}/${MUTANTS.length}; all mutants must be killed.`);
}
console.log(`P3.9 client mutation score ${killed}/${MUTANTS.length}; all target sources restored.`);
