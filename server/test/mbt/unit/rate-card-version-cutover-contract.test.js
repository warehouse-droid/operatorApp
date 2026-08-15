import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [migration, service] = await Promise.all([
  readFile(
    new URL("../../../migrations/161_mbt_rate_card_version_cutover.sql", import.meta.url),
    "utf8"
  ),
  readFile(
    new URL("../../../src/mbt/rate-card-configuration-service.js", import.meta.url),
    "utf8"
  )
]);

test("used rate versions permit only the audited active-to-retired transition", () => {
  assert.match(migration, /OLD\.status = 'active'[\s\S]*NEW\.status = 'retired'/u);
  assert.match(migration, /NEW\.revision = OLD\.revision \+ 1/u);
  assert.match(migration, /'status', 'effective_to', 'retired_at',[\s\S]*'revision', 'updated_by', 'updated_at'/u);
  assert.match(migration, /ERRCODE = '55000'/u);
  assert.doesNotMatch(
    migration,
    /'calculation_notes'|'validation_snapshot'|'first_used_at'/u,
    "Pricing, validation, and first-use evidence must not be in the mutable-field allowlist."
  );
});

test("activation uses one transaction timestamp and exact replacement identity", () => {
  assert.match(service, /activeVersionId !== replacesRateCardVersionId/u);
  assert.match(service, /SET status = 'retired'[\s\S]*SET status = 'active'/u);
  assert.match(service, /transaction_timestamp\(\) AS cutover_at/u);
  assert.match(service, /WHERE rate_card_id = \$1 AND active = false/u);
  assert.match(service, /replacedRateCardVersionId: activeVersionId/u);
});
