import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");

test("P2-F07: the P2 gauntlet selects persisted Phase 2 mutants and all broad gates", async () => {
  const source = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  assert.match(source, /baseline\|P1\|P2\|P3/);
  assert.match(source, /MBT_MUTATION_PHASE="\$mbt_mode"/);
  assert.match(source, /mbt-p2\.yml/);
  assert.match(source, /npm run test:mbt:shuffled/);
  assert.match(source, /npm run typecheck:mbt/);
  assert.match(source, /npm run lint:mbt/);
  assert.match(source, /npm run test:mbt:coverage/);
  assert.match(source, /npm run test:baseline:mbt:full|run --rm baseline/);
  assert.match(source, /npm run test:mbt:e2e|run --rm e2e/);
  assert.match(source, /npm audit --audit-level=high/);
});

test("P2-F07: the persisted mutation runner declares a separate nonempty Phase 2 set", async () => {
  const source = await readFile(path.join(serverRoot, "test/support/run-mutations.mjs"), "utf8");
  assert.match(source, /const P2_MUTANTS = Object\.freeze\(\[/);
  assert.match(source, /const LOCAL_ITEM_MUTANTS = Object\.freeze\(\[/);
  assert.match(source, /LOCAL_ITEM_MUTANTS\.length !== 7/);
  assert.match(source, /const BILLING_APPROVAL_MUTANTS = Object\.freeze\(\[/);
  assert.match(source, /BILLING_APPROVAL_MUTANTS\.length !== 4/);
  assert.match(source, /\.\.\.P2_MUTANTS,[\s\S]*\.\.\.LOCAL_ITEM_MUTANTS,[\s\S]*\.\.\.BILLING_APPROVAL_MUTANTS/);
  assert.match(source, /MBT_MUTATION_PHASE/);
  assert.match(source, /Phase 2 mutation score/);
  assert.match(source, /netsuite-readiness-(?:catalog|service|repository|report)|netsuite-readonly-adapter/);
  assert.match(source, /test\/mbt\/unit\/local-item-settings\.test\.js/);
  assert.match(source, /test\/mbt\/property\/local-item-settings\.property\.test\.js/);
  assert.match(source, /test\/mbt\/integration\/local-item-settings\.test\.js/);
  assert.match(source, /file: "local-item-settings(?:-repository)?\.js"/);
  assert.match(source, /DUMP is assigned a fake NetSuite item mapping/);
  assert.match(source, /local item readiness polarity is inverted/);
});

test("P2-F07: the direct secret command includes every Phase 2 runtime and migration source", async () => {
  const packageJson = JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8"));
  const command = String(packageJson.scripts?.["secrets:mbt"] || "");
  assert.match(command, /(?:^|\s)src\/mbt(?:\s|$)/);
  assert.match(command, /migrations\/108_mbt_netsuite_sandbox_readiness\.sql/);
  assert.match(command, /migrations\/109_mbt_local_first_configuration\.sql/);
});

test("P2-F07: the production-image gate selects P2 predeploy and runs the fail-closed endpoint smoke", async () => {
  const gauntlet = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  const predeploy = await readFile(path.join(serverRoot, "tools/mbt-predeploy-readiness.mjs"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8"));

  assert.match(gauntlet, /MBT_PREDEPLOY_PHASE=P2/);
  assert.match(gauntlet, /MBT_P2_RUNTIME_SMOKE=1/);
  assert.match(gauntlet, /preflight:mbt-p1-deploy/);
  assert.match(gauntlet, /preflight:mbt-p2-deploy/);
  assert.equal(
    packageJson.scripts?.["preflight:mbt-p2-deploy"],
    "node tools/mbt-predeploy-readiness.mjs"
  );
  assert.match(predeploy, /108_mbt_netsuite_sandbox_readiness\.sql/);
  assert.match(predeploy, /109_mbt_local_first_configuration\.sql/);
  assert.match(predeploy, /\/api\/mbt\/config\/netsuite\/preflight/);
  assert.match(predeploy, /P2_RUNTIME_ENDPOINT}\/latest/);
  assert.match(predeploy, /MBT_NETSUITE_DIRECT_ACCESS_REQUIRED/);
  assert.match(predeploy, /MBT_NETSUITE_WRITES_ENABLED/);
});
