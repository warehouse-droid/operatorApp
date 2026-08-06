import { readFile } from "node:fs/promises";

const ALLOWED_LICENSES = new Set([
  "(MIT AND Zlib)",
  "(MIT OR GPL-3.0-or-later)",
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT/X11",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense"
]);

const DOCUMENTED_BASELINE_EXCEPTIONS = new Map([
  [
    "node_modules/buffers",
    "buffers@0.1.1 is a pre-existing transitive dependency whose package and lock metadata contain no license declaration; manual legal review remains required."
  ]
]);

const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
const violations = [];
const baselineExceptions = [];
const licenses = new Map();
for (const [packagePath, metadata] of Object.entries(lock.packages || {})) {
  if (!packagePath || metadata.link) {
    continue;
  }
  const license = String(metadata.license || "").trim();
  if (!license && DOCUMENTED_BASELINE_EXCEPTIONS.has(packagePath)) {
    baselineExceptions.push(`${packagePath}: ${DOCUMENTED_BASELINE_EXCEPTIONS.get(packagePath)}`);
    continue;
  }
  if (!license || !ALLOWED_LICENSES.has(license)) {
    violations.push(`${packagePath}: ${license || "missing license metadata"}`);
  }
  licenses.set(license || "missing", (licenses.get(license || "missing") || 0) + 1);
}
if (violations.length > 0) {
  throw new Error(`Dependency license allowlist failed:\n${violations.join("\n")}`);
}
console.log(`Dependency licenses passed: ${lock.packages ? Object.keys(lock.packages).length - 1 : 0} packages.`);
for (const [license, count] of [...licenses].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${license}: ${count}`);
}
for (const exception of baselineExceptions) {
  console.warn(`BASELINE LICENSE EXCEPTION: ${exception}`);
}
