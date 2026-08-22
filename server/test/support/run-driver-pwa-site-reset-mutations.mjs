// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_TEST = "test/mbt/unit/driver-pwa-site-reset.test.js";
const HTTP_TEST = "test/mbt/integration/driver-pwa-site-reset-http.test.js";

/** @typedef {{ name: string, target: string, from: string, to: string, tests: string[] }} ResetMutant */

/** @type {readonly ResetMutant[]} */
const MUTANTS = Object.freeze([
  {
    name: "login screen advertises the destructive reset",
    target: "public/driver.js",
    from: '          <button class="primary" type="submit">${t("common.login", "Login")}</button>',
    to: '          <button class="primary" type="submit">${t("common.login", "Login")}</button>\n          <a href="/reset-driver">Hard reset</a>',
    tests: [SOURCE_TEST]
  },
  {
    name: "unconfirmed requests are accepted",
    target: "src/server.js",
    from: '    if (req.get("x-mbbs-driver-site-reset") !== "confirm") {',
    to: '    if (req.get("x-mbbs-driver-site-reset") === "confirm") {',
    tests: [SOURCE_TEST, HTTP_TEST]
  },
  {
    name: "same-origin requests are rejected while cross-site requests pass",
    target: "src/server.js",
    from: '    if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {',
    to: '    if (fetchSite && ["same-origin", "none"].includes(fetchSite)) {',
    tests: [SOURCE_TEST, HTTP_TEST]
  },
  {
    name: "persistent browser storage is omitted from Clear-Site-Data",
    target: "src/server.js",
    from: `    res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');`,
    to: `    res.setHeader("Clear-Site-Data", '"cache", "cookies"');`,
    tests: [SOURCE_TEST, HTTP_TEST]
  },
  {
    name: "destructive reset button is enabled without confirmation",
    target: "public/driver-reset.html",
    from: '        confirmation.addEventListener("change", () => {\n          resetButton.disabled = !confirmation.checked;\n        });',
    to: '        confirmation.addEventListener("change", () => {\n          resetButton.disabled = false;\n        });',
    tests: [SOURCE_TEST]
  },
  {
    name: "known Driver IndexedDB is no longer deleted on older WebKit",
    target: "public/driver-reset.html",
    from: '        const KNOWN_DRIVER_DATABASES = ["mbbs-driver-offline"];',
    to: "        const KNOWN_DRIVER_DATABASES = [];",
    tests: [SOURCE_TEST]
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {{ name: string, tests: string[] }} mutant */
function runTests(mutant) {
  process.stdout.write(`\n[driver-site-reset mutation] ${mutant.name}\n`);
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...mutant.tests],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" }
  );
  if (result.error) {
    throw result.error;
  }
  const status = result.status ?? 1;
  console.log(`test exit status: ${status}`);
  return {
    status,
    output: `${result.stdout || ""}${result.stderr || ""}`
  };
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Driver site-reset mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
/** @type {Map<string, string>} */
const originals = new Map();
/** @type {Map<string, string>} */
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (!original || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant).status === 0) {
      throw new Error(`${mutant.name}: survived the focused reset suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

for (const testFile of [SOURCE_TEST, HTTP_TEST]) {
  const restored = {
    name: `restored source: ${testFile}`,
    tests: [testFile]
  };
  const result = runTests(restored);
  if (result.status !== 0) {
    throw new Error(
      `Focused test failed after mutation restoration: ${testFile}\n${result.output.slice(-4000)}`
    );
  }
}

console.log(`Driver site-reset mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
