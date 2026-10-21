# Shared read-only load inspection

2026-09-27. Tier 2 UI correction. Spec approval: not obtained (autonomous run);
the user's explicit requirements are the acceptance criteria. Continue the
existing old-coder workflow without changing API authorization or lease rules.

1. A Dispatch load shown in BIN Planning uses the actual Dispatch load renderer:
   same assignment fields, stop sequence, timing, weights, warnings, hover
   tooltip and clickable title. No per-load navigation hyperlink. Grey background
   and Read only badge are the only presentation additions.
2. Clicking the title opens the shared preview, including stops, map, details,
   assigned orders and plan/forecast/actual timing. Collapse, close and resize
   work. Mutating controls are disabled, drag/drop and synthetic input events
   cannot change a read-only load, and double-click cannot open an edit form.
3. BIN loads in Dispatch use the same components and saved BIN stop sequence,
   addresses and timing. Dispatch requires no MBT endpoint to inspect them,
   including when MBT is disabled.
4. Viewing, hovering, opening/closing previews and refreshing display must not
   change in-memory or persisted assignments/timing or start a save. Editing
   loads owned by the active planner still works. Existing server preservation,
   date lease and confirmation behavior remain unchanged.
5. Return loads and grouped physical stops remain inspectable. Read-only
   selection persists through display refresh. Existing Dispatch styles supply
   hover effects; do not create a parallel card/preview layout.

Failure model: missing detail (browser comparison with Dispatch); accidental
mutation (disabled controls, event guard, persisted/in-memory snapshots); MBT
coupling (network assertion); changed editable planner (existing frontend and
BIN browser regression). No server, database or dependency changes planned.

Use existing isolated Docker/PostgreSQL/Chromium tooling. Add regression tests,
run RED before implementation, run relevant Dispatch/BIN suites, static checks,
browser execution and manual mutants. Record changed-line coverage limitations
and skipped layers explicitly. Preserve unrelated work; no git checkpoint
commits. Deployment, if performed, overlays only this correction onto the live
image, with asset cache version, health checks and rollback retained.

User clarification: show the actual assigned truck on each load. A driver's
flatbed-to-BIN or BIN-to-flatbed transition uses Dispatch's existing truck-switch
section, including yard, parking and timing; filtering the BIN assignment menu
must not hide a read-only flatbed's assigned truck.

Fixture corrections during RED/GREEN: Custom Order IDs are fixture-only, so
timing is persisted directly by the fixture instead of exercising their separate
creation validator; tooltip item names use the UI's SKU field. BIN fixture
service-time overrides now agree with its explicitly seeded arrival/departure
times, so the existing forecast is consistent with the saved plan. Behavioral
assertions are unchanged.

Repeat-run finding: a pool search overlapping date navigation can invalidate
the date's adopting feed request, allowing navigation to resolve with the prior
date's pool. Add a deterministic browser test with two gated feed responses.
Date navigation owns its feed adoption until complete; search refreshes during
that interval must not supersede it. Ordinary Dispatch code remains unaffected.
