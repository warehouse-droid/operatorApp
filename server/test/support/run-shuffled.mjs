// @ts-check

import { readdir } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const GROUPS = Object.freeze([
  "infrastructure",
  "unit",
  "contracts",
  "property",
  "integration",
  "adversarial",
  "concurrency"
]);
const SEEDS = Object.freeze([2_026_080_301, 2_026_080_337, 2_026_080_399]);

const explicitSeedText = String(process.env.MBT_SHUFFLE_SEED || "").trim();
const explicitSeed = explicitSeedText ? Number(explicitSeedText) : null;
if (explicitSeed !== null && (!Number.isSafeInteger(explicitSeed) || explicitSeed < 0)) {
  throw new Error("MBT_SHUFFLE_SEED must be a non-negative safe integer.");
}
const seeds = explicitSeed === null ? SEEDS : [explicitSeed];

/** @param {string} directory @returns {Promise<string[]>} */
async function testFiles(directory) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (/\.test\.(?:js|mjs)$/.test(entry.name)) {
        found.push(target);
      }
    }
  }
  await visit(directory);
  return found;
}

/** @param {number} seed */
function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** @param {string[]} values @param {number} seed */
function shuffled(values, seed) {
  const result = [...values];
  const random = randomSource(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    const currentValue = result[index];
    const selectedValue = result[selected];
    if (currentValue === undefined || selectedValue === undefined) {
      throw new RangeError("Shuffle selected a value outside the input array.");
    }
    result[index] = selectedValue;
    result[selected] = currentValue;
  }
  return result;
}

if (process.env.MBT_TEST_ISOLATED !== "1") {
  throw new Error("Shuffled tests require the isolated MBT environment.");
}
if (!/\/mbt_test(?:[?#]|$)/.test(String(process.env.DATABASE_URL || ""))) {
  throw new Error("Shuffled tests require the dedicated mbt_test database.");
}

const files = (await Promise.all(GROUPS.map((group) => testFiles(path.resolve("test/mbt", group))))).flat();
if (files.length === 0) {
  throw new Error("No MBT tests were found for shuffled execution.");
}
for (const seed of seeds) {
  console.log(`\n[shuffle] seed=${seed} files=${files.length}`);
  const exitCode = await runNodeTestFilesIsolated(shuffled(files, seed), {
    environment: process.env,
    label: `MBT shuffle ${seed}`
  });
  if (exitCode !== 0) {
    throw new Error(`Shuffled MBT run failed with seed ${seed}.`);
  }
}
console.log(`Shuffled MBT repetition passed: ${seeds.length} seed(s), ${files.length} files each.`);
