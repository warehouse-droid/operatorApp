// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/smart-scm-skip-12441.red.test.js",
  "test/mbt/property/smart-scm-skip-12441.property.test.js",
  "test/mbt/unit/smart-scm-phased-planning.red.test.js",
  "test/mbt/unit/smart-scm-blanket-split-inventory.red.test.js",
  "test/mbt/unit/scm-schedule-route-options.red.test.js",
  "test/mbt/unit/scm-po-split-adjustment.red.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string}>} */
const MUTANTS = Object.freeze([
  {
    name: "disabled skip mode rewrites demand",
    target: "src/smart-scm-skip-12441.js",
    from: "  if (!enabled) {\n    return { facts, allocations: [] };\n  }",
    to: "  if (enabled) {\n    return { facts, allocations: [] };\n  }"
  },
  {
    name: "missing attribution sends all demand to 3445",
    target: "src/smart-scm-skip-12441.js",
    from: "  return { sobRatio: 0.5, ratioSource: \"equal\" };",
    to: "  return { sobRatio: 1, ratioSource: \"equal\" };"
  },
  {
    name: "12441 retains a protected source floor",
    target: "src/smart-scm-skip-12441.js",
    from: "    sourceProtectedFloorPallets: 0",
    to: "    sourceProtectedFloorPallets: state.sourceProtectedFloorPallets"
  },
  {
    name: "12441 forecast keeps its zero-demand coverage floor",
    target: "src/smart-scm-skip-12441.js",
    from: "    coverageFloorPallets: 0,\n    zeroDemandCoverageApplied: false,",
    to: "    coverageFloorPallets: state.coverageFloorPallets,\n    zeroDemandCoverageApplied: true,"
  },
  {
    name: "skip mode permits automatic 12441 destinations",
    target: "src/smart-scm-skip-12441.js",
    from: "  return !skip12441Enabled || !skippedLocation(location);",
    to: "  return !skip12441Enabled || skippedLocation(location);"
  },
  {
    name: "phased planning keeps consolidation PO drafts instead of direct PO drafts",
    target: "src/smart-scm-phased-planning.js",
    from: "      && String(draft?.phase || \"\").toLowerCase() === \"direct_vendor\"",
    to: "      && String(draft?.phase || \"\").toLowerCase() === \"vendor_hub\""
  },
  {
    name: "closed purchase-order evidence becomes eligible",
    target: "src/smart-scm-phased-planning.js",
    from: "  if (row.closed === true || row.cancelled === true) {\n    return false;\n  }",
    to: "  if (row.closed === false || row.cancelled === false) {\n    return false;\n  }"
  },
  {
    name: "split inbound no longer leaves the source yard",
    target: "src/smart-scm-phased-planning.js",
    from: "      addInboundDelta(deltaMap, route.itemId, route.sourceLocationId, -route.quantity);",
    to: "      addInboundDelta(deltaMap, route.itemId, route.sourceLocationId, route.quantity);"
  },
  {
    name: "same-yard Blanket child is discarded",
    target: "src/smart-scm-phased-planning.js",
    from: "  return route.quantity > 0 && (\n    sourceAlreadyExcluded\n    || String(route.sourceLocationId) !== String(route.destinationLocationId)\n  );",
    to: "  return route.quantity > 0 && (\n    sourceAlreadyExcluded\n    && String(route.sourceLocationId) !== String(route.destinationLocationId)\n  );"
  },
  {
    name: "released Blanket child is swallowed by Blanket exclusion",
    target: "src/smart-scm-planning-repository.js",
    from: "        + releasedSplitInbound\n        + blanketReserved",
    to: "        + blanketReserved"
  },
  {
    name: "grouped PO pickup uses a union rather than vendor intersection",
    target: "src/scm-schedule-route-options.js",
    from: "  return normalized[0].filter((yard) => allowed.every((keys) => keys.has(routeKey(yard))));",
    to: "  return normalized[0].filter((yard) => allowed.some((keys) => keys.has(routeKey(yard))));"
  },
  {
    name: "TO drop-off options disappear",
    target: "src/scm-schedule-route-options.js",
    from: "  if (kind === \"TO\") {\n    return { pickupOptions: own, dropoffOptions: own };\n  }",
    to: "  if (kind === \"TO\") {\n    return { pickupOptions: own, dropoffOptions: [] };\n  }"
  },
  {
    name: "source quantity over-allocation guard is reversed",
    target: "src/scm-po-split-adjustment.js",
    from: "  if (change.delta > available + 0.000001) {",
    to: "  if (change.delta < available + 0.000001) {"
  },
  {
    name: "Blanket reduction consumes held quantity",
    target: "src/scm-po-split-adjustment.js",
    from: "    next.cancelled = Math.round((next.cancelled + reduction) * 1_000_000) / 1_000_000;",
    to: "    next.held = Math.round((next.held - reduction) * 1_000_000) / 1_000_000;"
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
  process.stdout.write(`\n[Smart SCM phased PO/split mutation] ${label}\n`);
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
  throw new Error("Smart SCM phased PO/split mutations require the writable disposable mutation container.");
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
console.log(`Smart SCM phased PO/split mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);
