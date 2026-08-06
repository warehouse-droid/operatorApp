// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const gauntlet = await readFile(new URL("../../../tools/mbt-gauntlet.sh", import.meta.url), "utf8");
const shuffled = await readFile(new URL("../../support/run-shuffled.mjs", import.meta.url), "utf8");
const mainRunner = await readFile(new URL("../../support/run-node-tests.mjs", import.meta.url), "utf8");

test("P3 gauntlet recreates the initial disposable database before the main suite", () => {
  assert.match(
    gauntlet,
    /echo "\[gauntlet\] recreating initial disposable PostgreSQL"\s+cleanup_mbt_stack\s+"\$\{mbt_compose_command\[@\]\}" up -d --wait db/u
  );
});

test("P3 gauntlet recreates and migrates the disposable database before every shuffle seed", () => {
  assert.match(gauntlet, /mbt_shuffle_seeds=\([^)]*2026080301[^)]*2026080337[^)]*2026080399[^)]*\)/su);
  assert.match(gauntlet, /for mbt_shuffle_seed in "\$\{mbt_shuffle_seeds\[@\]\}"; do/u);
  assert.match(gauntlet, /down --volumes --remove-orphans/u);
  assert.match(gauntlet, /up -d --wait db/u);
  assert.match(gauntlet, /run --rm migrate/u);
  assert.match(gauntlet, /-e MBT_SHUFFLE_SEED="\$mbt_shuffle_seed"/u);
});

test("the shuffled runner accepts one explicit seed and retains the adversarial group", () => {
  assert.match(shuffled, /process\.env\.MBT_SHUFFLE_SEED/u);
  assert.match(shuffled, /"adversarial"/u);
  assert.match(shuffled, /const seeds = explicitSeed === null \? SEEDS : \[explicitSeed\];/u);
});

test("main and shuffled Node suites execute each file through the isolated clone runner", () => {
  assert.match(mainRunner, /import \{ runNodeTestFilesIsolated \}/u);
  assert.match(mainRunner, /runNodeTestFilesIsolated\(files/u);
  assert.match(shuffled, /import \{ runNodeTestFilesIsolated \}/u);
  assert.match(shuffled, /runNodeTestFilesIsolated\(shuffled\(files, seed\)/u);
});
