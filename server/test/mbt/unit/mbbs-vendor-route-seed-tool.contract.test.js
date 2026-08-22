// @ts-check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../../tools/prepare-mbbs-po-vrma-v3.mjs", import.meta.url),
  "utf8"
);
const packageSource = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
const gauntletSource = await readFile(
  new URL("../../../tools/mbbs-vendor-route-rate-gauntlet.sh", import.meta.url),
  "utf8"
);
const sourceStateSource = await readFile(
  new URL("../../../tools/mbbs-vendor-route-rate-source-state.sh", import.meta.url),
  "utf8"
);

test("M7 reviewed v3 seed is dry-run by default, atomic, exact-count guarded, and never activates", () => {
  assert.match(source, /--apply-reviewed-draft/u);
  assert.match(source, /CREATE_REVIEWED_MBBS_V3_DRAFT/u);
  assert.match(source, /withTransaction/u);
  assert.match(source, /versionNumber\s*!==\s*2/u);
  assert.match(source, /versionThreeExists/u);
  assert.match(source, /plan\.suppliedCount\s*!==\s*71/u);
  assert.match(source, /plan\.mapped\.length\s*!==\s*54/u);
  assert.match(source, /plan\.fallback\.length\s*!==\s*17/u);
  assert.match(source, /activationPerformed:\s*false/u);
  assert.doesNotMatch(source, /activateLocalRateCardVersion/u);
});

test("M9 reviewed v3 reconciliation is guarded, atomic, exact-graph checked, and never activates", () => {
  assert.match(source, /--reconcile-reviewed-draft/u);
  assert.match(source, /RECONCILE_REVIEWED_MBBS_V3_DRAFT/u);
  assert.match(source, /--draft-version-id/u);
  assert.match(source, /versionNumber\s*!==\s*3/u);
  assert.match(source, /status\s*!==\s*"draft"/u);
  assert.match(source, /firstUsedAt/u);
  assert.match(source, /sameRateCard/u);
  assert.match(source, /expectedPriorRows/u);
  assert.match(source, /replaceLocalRateCardDraft/u);
  assert.match(source, /activationPerformed:\s*false/u);
  assert.doesNotMatch(source, /activateLocalRateCardVersion/u);
});

test("M8 persisted gauntlet is isolated, complete, reproducible, and cannot select the production Compose project", () => {
  assert.match(packageSource, /gauntlet:mbt:mbbs-vendor-route-rates/u);
  assert.match(packageSource, /coverage:mbt:mbbs-vendor-route-rates/u);
  assert.match(packageSource, /mutate:mbt:mbbs-vendor-route-rates/u);
  assert.match(gauntletSource, /test:mbt:mbbs-vendor-route-rates/u);
  assert.match(gauntletSource, /npm run test:mbt(?:\s|$)/u);
  assert.match(gauntletSource, /typecheck:mbt/u);
  assert.match(gauntletSource, /lint:mbt/u);
  assert.match(gauntletSource, /MBT_MUTATION_EPHEMERAL=1/u);
  assert.match(gauntletSource, /MBT_SHUFFLE_SEED=2026081601/u);
  assert.match(gauntletSource, /p3-config-friendly-editor\.spec\.js/u);
  assert.match(gauntletSource, /p3-billing\.spec\.js/u);
  assert.match(gauntletSource, /down --volumes --remove-orphans/u);
  assert.match(gauntletSource, /Refusing to use the production Compose project/u);
  assert.doesNotMatch(gauntletSource, /-f\s+["']?\$\{repo_root\}\/docker-compose\.yml/u);
  assert.match(sourceStateSource, /sha256sum/u);
  assert.match(sourceStateSource, /mbbs-vendor-route-rates\.js/u);
});
