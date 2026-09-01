// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/smart-scm-blanket-residual-coverage.red.test.js",
  "test/mbt/property/smart-scm-blanket-residual-coverage.property.test.js",
  "src/smart-scm-run-validator-harness.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string}>} */
const MUTANTS = Object.freeze([
  {
    name: "lower urgency consumes the shared pool first",
    target: "src/smart-scm-blanket-coverage.js",
    from: "  const urgency = urgencyRank(right) - urgencyRank(left);",
    to: "  const urgency = urgencyRank(left) - urgencyRank(right);"
  },
  {
    name: "lower urgency score wins the tie",
    target: "src/smart-scm-blanket-coverage.js",
    from: "  const score = positive(right.urgencyScore ?? right.urgency_score)\n    - positive(left.urgencyScore ?? left.urgency_score);",
    to: "  const score = positive(left.urgencyScore ?? left.urgency_score)\n    - positive(right.urgencyScore ?? right.urgency_score);"
  },
  {
    name: "higher location ID wins the final demand tie",
    target: "src/smart-scm-blanket-coverage.js",
    from: "  return number(left?.policy?.location_id, Number.MAX_SAFE_INTEGER)\n    - number(right?.policy?.location_id, Number.MAX_SAFE_INTEGER);",
    to: "  return number(right?.policy?.location_id, Number.MAX_SAFE_INTEGER)\n    - number(left?.policy?.location_id, Number.MAX_SAFE_INTEGER);"
  },
  {
    name: "newest Blanket source is consumed first",
    target: "src/smart-scm-blanket-coverage.js",
    from: "  const dateDifference = sourceDate(left.row) - sourceDate(right.row);",
    to: "  const dateDifference = sourceDate(right.row) - sourceDate(left.row);"
  },
  {
    name: "fractional source balance rounds up to a pallet",
    target: "src/smart-scm-blanket-coverage.js",
    from: "      remainingPallets: Math.floor(positive(value(row, \"remainingPallets\", \"remaining_pallets\")))",
    to: "      remainingPallets: Math.ceil(positive(value(row, \"remainingPallets\", \"remaining_pallets\")))"
  },
  {
    name: "manual PO pause still consumes Blanket stock",
    target: "src/smart-scm-blanket-coverage.js",
    from: "    if (state.policy?.temporarily_excluded === true) continue;",
    to: "    if (state.policy?.temporarily_excluded === false) continue;"
  },
  {
    name: "fractional demand rounds up for Blanket coverage",
    target: "src/smart-scm-blanket-coverage.js",
    from: "    let needed = Math.floor(positive(state.requiredPallets));",
    to: "    let needed = Math.ceil(positive(state.requiredPallets));"
  },
  {
    name: "matching item source is skipped",
    target: "src/smart-scm-blanket-coverage.js",
    from: "        || Number(value(source.row, \"itemId\", \"item_id\")) !== itemId",
    to: "        || Number(value(source.row, \"itemId\", \"item_id\")) === itemId"
  },
  {
    name: "allocation may overdraw a source line",
    target: "src/smart-scm-blanket-coverage.js",
    from: "      const pallets = Math.min(needed, source.remainingPallets);",
    to: "      const pallets = Math.max(needed, source.remainingPallets);"
  },
  {
    name: "Blanket quantity is added to rather than subtracted from residual",
    target: "src/smart-scm-blanket-coverage.js",
    from: "      Math.max(0, positive(state.requiredPallets) - positive(state.blanketCoveragePallets))",
    to: "      Math.max(0, positive(state.requiredPallets) + positive(state.blanketCoveragePallets))"
  },
  {
    name: "run totals label residual pallets as Blanket-covered pallets",
    target: "src/smart-scm-blanket-coverage.js",
    from: "      .reduce((sum, row) => sum + positive(row.coveredPallets), 0)),",
    to: "      .reduce((sum, row) => sum + positive(row.residualPallets), 0)),"
  },
  {
    name: "ordinary planning ignores the residual quantity",
    target: "src/smart-scm-planning-repository.js",
    from: "    const ordinaryPlanningNeed = state.residualRequiredPallets === undefined\n      ? positive(state.requiredPallets)\n      : positive(state.residualRequiredPallets);",
    to: "    const ordinaryPlanningNeed = positive(state.requiredPallets);"
  },
  {
    name: "phase-two transfer planning ignores the residual quantity",
    target: "src/smart-scm-planning-repository.js",
    from: "      requestedPallets: state.residualRequiredPallets === undefined\n        ? state.requiredPallets\n        : state.residualRequiredPallets,",
    to: "      requestedPallets: state.requiredPallets,"
  },
  {
    name: "Blanket release drafts use residual instead of allocated pallets",
    target: "src/smart-scm-blanket-repository.js",
    from: "      const pallets = positive(allocation.pallets);",
    to: "      const pallets = positive(state.residualRequiredPallets);"
  },
  {
    name: "validator excludes Blanket quantity from combined coverage",
    target: "src/smart-scm-run-validator.js",
    from: "    const combinedCoveragePallets = proposedPallets + blanketCoveragePallets;",
    to: "    const combinedCoveragePallets = proposedPallets;"
  },
  {
    name: "validator adds Blanket quantity to expected residual",
    target: "src/smart-scm-run-validator.js",
    from: "    const expectedResidualPallets = Math.max(0, requiredPallets - blanketCoveragePallets);",
    to: "    const expectedResidualPallets = Math.max(0, requiredPallets + blanketCoveragePallets);"
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

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[Smart SCM Blanket residual mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Smart SCM Blanket residual mutations require the writable disposable mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
const originals = new Map();
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
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
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

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`Smart SCM Blanket residual mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
