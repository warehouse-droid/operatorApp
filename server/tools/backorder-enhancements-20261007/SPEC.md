# Backorder enhancements, 2026-10-07

Spec approval: not obtained (autonomous run). The user authorized implementation
and deployment after passing tests; the acceptance list below is agent-authored.

1. Sales sees exactly Pickup and Delivery choices. Delivery shows address,
   contact, date, window start/end and instructions. Pickup hides these fields.
   Changing the method preserves unsaved notes and validates delivery addresses.
   Legacy saved vendor-pickup cases remain readable and completable.
2. Desktop input groups use three columns, with Sales internal note and Request
   remark side by side. Narrow screens stack the fields. New and edit forms have
   no sales price or discount inputs; editing preserves saved legacy prices.
3. Every material has an independent vendor and destination yard. Catalog vendor
   and request yard supply defaults; Sales can change either on an individual
   line. Saved routing survives reload and appears to SCM. All line destinations
   must be among the Sales user's permitted yards, including edits.
4. SCM can review Backorder lines from different vendors. Special requests retain
   their single-vendor rule. Reviewing one line never changes another line's
   vendor, yard or confirmation. Lists filter on any Backorder line's vendor/yard.
5. Migration 269 is additive: backfill routing from existing catalog/response and
   request yard, preserve all existing fields. Rehearse rollback and interrupted
   DDL in an isolated database. Refuse downgrade once routing data would be lost.
6. Keep regular SKU/UOM identity, revision locking, private notes, manual synced
   order references and disabled NetSuite generation/ancillary lines unchanged.
   No production test records or unrelated production source updates.

Failure model: lost line routing (HTTP persistence and reload assertions), yard
scope bypass (unauthorized create/edit and no partial writes), mixed-vendor rule
leaking into Special (separate profile tests), stale revisions (existing suite),
hidden delivery fields losing input (browser toggle/save), destructive migration
(snapshot/up/down/re-up and interrupted transaction), packaging drift (live hashes).

Setup: reuse installed Node, Playwright, c8, TypeScript, ESLint and fast-check;
no dependencies, lockfile updates or git commits. Save current src/public baseline,
test/evidence and reproducible scripts here. All test containers use the standard
bounded isolated Compose stack and are removed with volumes/networks in finally.
Run the affected regression suites on baseline and candidate and require zero new
failures; compare type/lint diagnostics, collect changed-line/branch coverage,
test properties, reverse suite order, and kill at least five real source mutants.
Deploy a narrow overlay onto the current app image after successful checks;
preserve runtime configuration and the worker image.

RED fixture correction: initial routing tests omitted the currently required rate
and failed before routing. Supply a zero rate for routing-only assertions and
rerun RED; browser and unpriced-create assertions cover removing that requirement.

UI review: hide the regular stock approval/TO explanation for Backorder because
it does not describe its manual-link workflow. Keep that explanation for other types.

Coverage review: also assert the list UI's multi-yard filter finds a Backorder by
its second line, including a mixed selection. This verifies the same routing
criterion for both scalar and array filter parameters.

Release compatibility: an old-version Backorder creation after migration 269 but
before app restart must receive the request yard and catalog vendor defaults.
Rehearse this exact old-source write to prevent a missing-route deployment gap.
