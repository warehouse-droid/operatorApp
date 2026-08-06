import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(supportDirectory, "../..");
const sourcePath = path.join(supportDirectory, "validate-playwright-report.mjs");
const contractPath = path.join(serverRoot, "test/mbt/infrastructure/playwright-report-validator.test.js");
const propertyPath = path.join(serverRoot, "test/mbt/property/playwright-report-validator.property.test.js");
const EXPECTED_MUTANTS = 6;
const MUTANTS = Object.freeze([
  {
    name: "ignores report-level errors",
    from: "if (report.errors.length > 0)",
    to: "if (report.errors.length < 0)"
  },
  {
    name: "ignores unexpected tests",
    from: "if (report.stats.unexpected !== 0)",
    to: "if (report.stats.unexpected < 0)"
  },
  {
    name: "ignores flaky tests",
    from: "if (report.stats.flaky !== 0)",
    to: "if (report.stats.flaky < 0)"
  },
  {
    name: "ignores expected-status skips",
    from: 'return playwrightTest?.expectedStatus === "skipped"',
    to: "return false"
  },
  {
    name: "accepts runtime skips",
    from: "if (skipped.length !== 0)",
    to: "if (skipped.length < 0)"
  },
  {
    name: "ignores the JSON stats skip count",
    from: "if (report.stats.skipped !== skipped.length)",
    to: "if (report.stats.skipped < 0)"
  }
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function applyOne(source, mutant) {
  const occurrences = source.split(mutant.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Mutant '${mutant.name}' expected one source match, observed ${occurrences}.`);
  }
  return source.replace(mutant.from, mutant.to);
}

function runContract(workspace, files) {
  return spawnSync(
    process.execPath,
    ["--test", ...files],
    { cwd: workspace, encoding: "utf8" }
  );
}

async function prepareWorkspace(workspace, source, contract, propertyContract) {
  const supportTarget = path.join(workspace, "test/support");
  const contractTarget = path.join(workspace, "test/mbt/infrastructure");
  const propertyTarget = path.join(workspace, "test/mbt/property");
  await mkdir(supportTarget, { recursive: true });
  await mkdir(contractTarget, { recursive: true });
  await mkdir(propertyTarget, { recursive: true });
  await symlink(path.join(serverRoot, "node_modules"), path.join(workspace, "node_modules"), "dir");
  await writeFile(path.join(workspace, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(supportTarget, "validate-playwright-report.mjs"), source);
  await writeFile(path.join(contractTarget, "playwright-report-validator.test.js"), contract);
  await writeFile(path.join(propertyTarget, "playwright-report-validator.property.test.js"), propertyContract);
}

async function killMutants(workspace, source) {
  const target = path.join(workspace, "test/support/validate-playwright-report.mjs");
  const propertyContract = ["test/mbt/property/playwright-report-validator.property.test.js"];
  for (const mutant of MUTANTS) {
    await writeFile(target, applyOne(source, mutant));
    const result = runContract(workspace, propertyContract);
    if (result.status === 0) {
      throw new Error(`Phase 3 gauntlet artifact mutant survived: ${mutant.name}`);
    }
  }
  await writeFile(target, source);
}

async function main() {
  if (MUTANTS.length !== EXPECTED_MUTANTS) {
    throw new Error(`Expected ${EXPECTED_MUTANTS} Phase 3 gauntlet artifact mutants.`);
  }
  const [source, contract, propertyContract] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(contractPath, "utf8"),
    readFile(propertyPath, "utf8")
  ]);
  const sourceHash = sha256(source);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mbt-p3-artifact-mutants-"));
  try {
    await prepareWorkspace(workspace, source, contract, propertyContract);
    const baseline = runContract(workspace, [
      "test/mbt/infrastructure/playwright-report-validator.test.js",
      "test/mbt/property/playwright-report-validator.property.test.js"
    ]);
    if (baseline.status !== 0) {
      throw new Error(`Phase 3 gauntlet artifact mutation baseline failed:\n${baseline.stderr}${baseline.stdout}`);
    }
    await killMutants(workspace, source);
    const restoredSource = await readFile(sourcePath, "utf8");
    if (sha256(restoredSource) !== sourceHash) {
      throw new Error("Phase 3 gauntlet artifact source restoration hash mismatch.");
    }
    console.log("6/6 Phase 3 gauntlet artifact mutants killed by the property suite alone.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
